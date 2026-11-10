const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const config = require('../config');

const s3Config = {
  region: config.aws.region,
};

if (config.aws.accessKeyId && config.aws.secretAccessKey) {
  s3Config.credentials = {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  };
}

const s3 = new S3Client(s3Config);

const createS3Upload = (bucketName = config.aws.bucketName) =>
  multer({
    storage: multerS3({
      s3,
      bucket: bucketName || 'default-bucket',
      metadata: (req, file, cb) => {
        cb(null, { fieldName: file.fieldname });
      },
      key: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
      },
    }),
  });

const uploadS3 = createS3Upload();

module.exports = { s3, uploadS3, createS3Upload };
