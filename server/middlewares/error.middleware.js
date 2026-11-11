const multer = require('multer');

const notFoundHandler = (req, res) => {
  if (res.headersSent) {
    return;
  }
  res.status(404).json({
    error: 'Resource not found',
  });
};

const errorHandler = (err, req, res, next) => {
  // If headers have already been sent to the client, delegate to the default Express error handler
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: `File upload error: ${err.message}`,
    });
  }

  const statusCode = err.status || err.statusCode || 500;
  return res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
  });
};

module.exports = {
  notFoundHandler,
  errorHandler,
};
