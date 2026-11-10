const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');

const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.php',
  '.jsp',
  '.asp',
  '.aspx',
  '.dll',
  '.msi',
  '.vbs',
  '.scr',
  '.com',
]);

// Ensure upload directory exists
if (!fs.existsSync(config.paths.uploads)) {
  fs.mkdirSync(config.paths.uploads, { recursive: true });
}

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    const err = new Error(`File type "${ext}" is not permitted for security reasons.`);
    err.status = 400;
    return cb(err, false);
  }
  return cb(null, true);
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.paths.uploads);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeOriginalName}`);
  },
});

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.limits.maxFileSize,
  },
});

module.exports = { upload, fileFilter, BLOCKED_EXTENSIONS };
