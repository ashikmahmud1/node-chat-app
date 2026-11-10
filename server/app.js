const express = require('express');
const config = require('./config');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middlewares/error.middleware');

const createApp = (usersInstance = null) => {
  const app = express();

  app.disable('x-powered-by');

  // Standard security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Serve static frontend assets
  app.use(express.static(config.paths.public));

  // Optional active rooms discovery endpoint
  app.get('/api/rooms', (req, res) => {
    const rooms = usersInstance ? usersInstance.getActiveRooms() : [];
    res.status(200).json({ rooms });
  });

  // Register API and file download routes
  app.use('/', routes);

  // 404 and centralized error handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

module.exports = { createApp };
