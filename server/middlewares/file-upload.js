const path = require('node:path');
const multer = require('multer');
const config = require('../config');

const executableExtensions = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.php', '.jsp', '.asp', '.aspx', '.dll', '.msi', '.vbs', '.scr', '.com',
]);

const uploadOptions = {
  defParamCharset: 'utf8',
  fileFilter(req, file, callback) {
    if (executableExtensions.has(path.extname(file.originalname.trim()).toLowerCase())) {
      return callback(Object.assign(new Error('Executable and script files are not supported.'), { status: 415 }));
    }
    return callback(null, true);
  },
  limits: { fileSize: config.limits.maxFileSize, files: 1, fields: 0, parts: 2 },
};

const upload = multer({
  ...uploadOptions,
  storage: multer.diskStorage({
    destination: (req, file, callback) => callback(null, config.paths.uploads),
    filename: (req, file, callback) => callback(null, req.attachmentId),
  }),
});

module.exports = { upload, uploadOptions };
