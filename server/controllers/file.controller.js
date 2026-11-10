const fs = require('fs');
const path = require('path');
const config = require('../config');

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

const downloadFile = (req, res, next) => {
  const rawFilename = req.params.filename || '';
  const safeFilename = path.basename(rawFilename);

  if (!safeFilename || safeFilename !== rawFilename) {
    return res.status(400).json({ error: 'Invalid file name.' });
  }

  const filePath = path.join(config.paths.uploads, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  return res.download(filePath, safeFilename, (err) => {
    if (err && !res.headersSent) {
      next(err);
    }
  });
};

module.exports = {
  uploadFile,
  downloadFile,
};
