/* eslint-disable no-multi-str */
/* eslint-disable no-template-curly-in-string */
/* eslint-disable no-new */

import {Stack, CfnOutput, RemovalPolicy, Duration, StackProps} from 'aws-cdk-lib';
import { CfnServer, CfnUser } from 'aws-cdk-lib/aws-transfer';
import {Vpc, SecurityGroup, CfnEIP, Peer, Port} from 'aws-cdk-lib/aws-ec2';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Role, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, BlockPublicAccess, EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { options } from '../../config';

/**
 * Deploys an AWS Transfer Server with optional custom hostname and certificate.
 * User(s) are created with SSH key authentication.
 * S3 triggers a Lambda extracting function.
 * An optional custom Lambda resource can import a custom Host key for the server.
 *
 * @param {Construct} scope
 * @param {string} id
 * @param {StackProps=} props
 */
export class ApplicationStack extends Stack {
    certificate?: ICertificate | Certificate;

    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        const {users} = options;
        // Use an existing VPC if specified in options, or the default VPC if not
        const vpc = Vpc.fromLookup(this, 'vpc', {isDefault: true});
        const {vpcId} = vpc;

        // Get public subnets from the VPC and confirm we have at least one
        const subnets = vpc.publicSubnets;
        if (!subnets.length) {
            throw new Error('We need at least one public subnet in the VPC');
        }
        const subnetIds = subnets.map((subnet) => subnet.subnetId);

        // Logging Role
        const loggingRole = new Role(this, 'loggingRole', {
            assumedBy: new ServicePrincipal('transfer.amazonaws.com'),
            description: 'Logging Role for the SFTP Server',
        });
        loggingRole.addToPrincipalPolicy(new PolicyStatement({
            sid: 'Logs',
            actions: [
                'logs:CreateLogStream',
                'logs:DescribeLogStreams',
                'logs:CreateLogGroup',
                'logs:PutLogEvents',
            ],
            resources: ['*'],
        }));

        // Security Group
        const sg = new SecurityGroup(this, 'sg', {
            description: 'SFTP Server Sg',
            vpc,
            allowAllOutbound: true,
        });
        sg.addIngressRule(Peer.anyIpv4(), Port.tcp(22), 'allow public SFTP access');

        // EIP addresses for the server. Optional, but allows for your customers/users to whitelist your server
        const addressAllocationIds = subnetIds.map((sid) => (new CfnEIP(this, `eip${sid}`)).attrAllocationId);

        // Create the SFTP server
        const server = new CfnServer(this, 'sftpServer', {
            domain: 'S3',
            endpointType: 'VPC',
            identityProviderType: 'SERVICE_MANAGED',
            loggingRole: loggingRole.roleArn,
            protocols: ['SFTP'],
            endpointDetails: {
                addressAllocationIds,
                vpcId,
                subnetIds,
                securityGroupIds: [sg.securityGroupId],
            },
            certificate: this.certificate ? this.certificate.certificateArn : undefined,
        });

        // Server attributes
        const serverId = server.attrServerId;
        const domainName = `${serverId}.server.transfer.${this.region}.amazonaws.com`;
        new CfnOutput(this, 'domainName', {
            description: 'Server endpoint hostname',
            value: domainName,
        });

        // S3 Bucket for incoming files
        const sftpBucket = new Bucket(this, 'sftpBucket', {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // User Resources ==================================================================================================

        // Base role for Users. SFTP User policy below restricts users to their own home folder only.
        // The base role must include all permissions that will be assigned to users.
        const userRole = new Role(this, 'userRole', {
            assumedBy: new ServicePrincipal('transfer.amazonaws.com'),
            description: 'SFTP standard user role',
        });
        userRole.addToPrincipalPolicy(new PolicyStatement({
            sid: 'List',
            actions: ['s3:ListBucket'],
            resources: ['*'],
        }));
        userRole.addToPrincipalPolicy(new PolicyStatement({
            sid: 'UserObjects',
            actions: [
                's3:PutObject',
                's3:GetObject',
                's3:GetObjectVersion',
            ],
            resources: [`${sftpBucket.bucketArn}/*`],
        }));

        // Users
        users.forEach((user: { userName: string; publicKey: string; }, i) => {
            const {userName, publicKey} = user;
            new CfnUser(this, `user${i + 1}`, {
                role: userRole.roleArn,
                serverId,
                userName,
                homeDirectory: `/${sftpBucket.bucketName}/home/${userName}`,
                sshPublicKeys: [publicKey],
                policy: '{ \n\
                    "Version": "2012-10-17", \n\
                            "Statement": [ \n\
                                { \n\
                                    "Sid": "AllowListingOfUserFolder", \n\
                                    "Effect": "Allow", \n\
                                    "Action": "s3:ListBucket", \n\
                                    "Resource": "arn:aws:s3:::${transfer:HomeBucket}", \n\
                                    "Condition": { \n\
                                        "StringLike": { \n\
                                            "s3:prefix": [ \n\
                                                "home/${transfer:UserName}/*", \n\
                                                "home/${transfer:UserName}" \n\
                                            ] \n\
                                        } \n\
                                    } \n\
                                }, \n\
                                { \n\
                                    "Sid": "HomeDirObjectAccess", \n\
                                    "Effect": "Allow", \n\
                                    "Action": [ \n\
                                        "s3:PutObject", \n\
                                        "s3:GetObject", \n\
                                        "s3:GetObjectVersion" \n\
                                    ], \
                                    "Resource": "arn:aws:s3:::${transfer:HomeDirectory}*" \n\
                                } \n\
                            ] \n\
                    } \n\
                ',
            });
        });

        const extractBucket = new Bucket(this, 'extractBucket', {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        const extractFnc = new Function(this, 'extractFnc', {
            description: 'Lambda SFTP Extract Function',
            runtime: Runtime.NODEJS_14_X,
            handler: 'index.handler',
            timeout: Duration.seconds(10),
            code: Code.fromAsset(`${__dirname}/lambda/extract`),
            environment: {
                EXTRACT_BUCKET: extractBucket.bucketName,
            },
        });
        // Add notification event to S3
        sftpBucket.addEventNotification(EventType.OBJECT_CREATED_PUT, new LambdaDestination(extractFnc));
    }
}
