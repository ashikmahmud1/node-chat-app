const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const config = require('../config');
const { uploadOptions } = require('./file-upload');

const s3 = new S3Client({
  region: config.aws.region,
  forcePathStyle: config.aws.forcePathStyle,
  endpoint: config.aws.endpoint || undefined,
});

async function verifyBucket() {
  await s3.send(new HeadBucketCommand({ Bucket: config.aws.bucketName }), { abortSignal: AbortSignal.timeout(10000) });
}

const uploadS3 = multer({
  ...uploadOptions,
  storage: multerS3({
    s3,
    bucket: config.aws.bucketName,
    key: (req, file, callback) => callback(null, req.attachmentId),
    contentType: (req, file, callback) => callback(null, 'application/octet-stream'),
  }),
});

module.exports = { s3, uploadS3, verifyBucket };
