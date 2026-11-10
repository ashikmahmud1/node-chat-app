const express = require('express');
const config = require('../config');
const { upload } = require('../middlewares/file-upload');
const { uploadS3 } = require('../middlewares/file-upload-s3');
const { uploadFile, downloadFile } = require('../controllers/file.controller');

const router = express.Router();

const activeUploadMiddleware =
  config.storageType === 's3' && config.aws.bucketName ? uploadS3 : upload;

router.post('/upload', activeUploadMiddleware.single('file'), uploadFile);
router.get('/data/:filename', downloadFile);

module.exports = router;
