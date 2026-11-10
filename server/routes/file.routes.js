const express = require('express');
const { upload } = require('../middlewares/file-upload');
const { uploadFile, downloadFile } = require('../controllers/file.controller');

const router = express.Router();

router.post('/upload', upload.single('file'), uploadFile);
router.get('/data/:filename', downloadFile);

module.exports = router;
