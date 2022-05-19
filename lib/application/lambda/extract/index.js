// eslint-disable-next-line import/no-extraneous-dependencies
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

function urlDecode(str) {
    // Removes url encoding from S3 keys in notifications
    return decodeURIComponent(str.replace(/\+/g, ' '));
}

const extractBucket = process.env.EXTRACT_BUCKET;

/**
 * Trigger file upload from S3 and move 20 characters of every file to the extracting bucket
 * @param {object} event
 * @param {object[]} event.Records - S3 Records
 */
exports.handler = async (event) => {
    console.log('Event: ', JSON.stringify(event));

    try {
        const s3Events = [];
        event.Records.forEach((record) => {
            const msg = JSON.parse(record.Sns.Message);
            msg.Records.forEach((rec) => s3Events.push(rec));
        });
        console.log('s3Events', JSON.stringify((s3Events)));
        await Promise.all(event.Records.map(async (record) => {
            const { bucket, object } = record.s3;

            // Copy 20 characters of the file to the extract bucket
            const file = await s3.getObject({
                Bucket: bucket.name,
                Key: urlDecode(object.key),
            })
                .promise();
            await s3.upload({
                Bucket: extractBucket,
                Key: urlDecode(object.key), // Original key name wanted
                Body: file.Body.toString().substring(0, 20)
            }).promise();

            // Delete the original file
            await s3.deleteObject({
                Bucket: bucket.name,
                Key: urlDecode(object.key), // Original key name required
            }).promise();
        }));
        return { success: true };
    } catch (err) {
        err.message = (err.message) || 'Internal handler error';
        console.log('Error caught: ', err);
        throw err;
    }
};
