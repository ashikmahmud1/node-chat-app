const fs = require('fs');
const path = require('path');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const config = require('../config');
const { s3 } = require('../middlewares/file-upload-s3');
const { logger } = require('../utils/logger');

const uploadFile = (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided for upload.' });
  }

  const normalizedFile = {
    ...req.file,
    filename: req.file.filename || req.file.key || req.file.originalname,
  };

  return res.status(200).json({ file: normalizedFile });
};

const downloadFile = async (req, res, next) => {
  const rawFilename = req.params.filename || '';
  const safeFilename = path.basename(rawFilename);

  if (!safeFilename || safeFilename !== rawFilename) {
    return res.status(400).json({ error: 'Invalid file name.' });
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

  // If storageType is S3, stream object from SeaweedFS / S3 endpoint
  if (config.storageType === 's3') {
    try {
      const command = new GetObjectCommand({
        Bucket: config.aws.bucketName,
        Key: safeFilename,
      });
      const s3Response = await s3.send(command);

      if (s3Response.ContentType) {
        res.setHeader('Content-Type', s3Response.ContentType);
      }
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

      if (s3Response.Body && typeof s3Response.Body.pipe === 'function') {
        s3Response.Body.on('error', (streamErr) => {
          logger.error('Error streaming S3 object body', { error: streamErr.message });
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream file.' });
          } else {
            res.end();
          }
        });
        return s3Response.Body.pipe(res);
      }

      if (!res.headersSent) {
        return next(new Error('S3 response body is not a readable stream.'));
      }
      return res.end();
    } catch (err) {
      if (!res.headersSent) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          return res.status(404).json({ error: 'File not found.' });
        }
        logger.error('Error fetching file from S3 storage', { error: err.message });
        return next(err);
      }
      return res.end();
    }
  }

  // Local filesystem storage fallback
  const filePath = path.join(config.paths.uploads, safeFilename);

  if (!fs.existsSync(filePath)) {
    if (!res.headersSent) {
      return res.status(404).json({ error: 'File not found.' });
    }
    return res.end();
  }

  return res.download(filePath, safeFilename, (err) => {
    if (err) {
      if (!res.headersSent) {
        return next(err);
      }
      logger.warn('Download stream aborted after headers were sent', { error: err.message });
    }
  });
};

module.exports = {
  uploadFile,
  downloadFile,
};
