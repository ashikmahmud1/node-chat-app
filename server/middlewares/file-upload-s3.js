const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const config = require('../config');
const { fileFilter } = require('./file-upload');
const { logger } = require('../utils/logger');

const buildS3Client = () => {
  const s3Config = {
    region: config.aws.region,
    forcePathStyle: config.aws.forcePathStyle,
  };

  if (config.aws.endpoint) {
    s3Config.endpoint = config.aws.endpoint;
  }

  if (config.aws.accessKeyId && config.aws.secretAccessKey) {
    s3Config.credentials = {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    };
  }

  return new S3Client(s3Config);
};

const s3 = buildS3Client();

const ensureBucketExists = async (bucketName = config.aws.bucketName) => {
  if (!bucketName) return;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
        logger.info(`S3 bucket created: ${bucketName}`);
      } catch (createErr) {
        logger.warn(`Could not auto-create S3 bucket ${bucketName}`, { error: createErr.message });
      }
    } else {
      logger.debug(`S3 bucket check: ${err.message}`);
    }
  }
};

const createS3Upload = (bucketName = config.aws.bucketName) =>
  multer({
    fileFilter,
    limits: {
      fileSize: config.limits.maxFileSize,
    },
    storage: multerS3({
      s3,
      bucket: bucketName || 'chat-app-uploads',
      metadata: (req, file, cb) => {
        cb(null, { fieldName: file.fieldname });
      },
      key: (req, file, cb) => {
        const safeOriginalName = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeOriginalName}`);
      },
    }),
  });

const uploadS3 = createS3Upload();

module.exports = { s3, uploadS3, createS3Upload, buildS3Client, ensureBucketExists };
