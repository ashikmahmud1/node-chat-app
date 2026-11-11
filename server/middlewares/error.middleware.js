const multer = require('multer');
const { logger } = require('../utils/logger');

const notFoundHandler = (req, res) => res.status(404).json({ error: 'Resource not found.' });

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error instanceof multer.MulterError
    ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    : (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500);
  if (status === 500) logger.error('HTTP request failed', { requestId: req.requestId, error: error.message });
  return res.status(status).json({
    error: status === 500 ? 'The server could not complete the request.' :
      status === 413 ? 'Files must be 50 MB or smaller.' :
      status === 404 ? 'Resource not found.' :
      status === 415 ? 'This file type is not allowed.' : 'Invalid request.',
  });
}

module.exports = { notFoundHandler, errorHandler };
