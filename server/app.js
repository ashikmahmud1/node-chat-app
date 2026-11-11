const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const express = require('express');
const config = require('./config');
const routes = require('./routes');
const { createHttpRateLimiter } = require('./middlewares/rate-limit.middleware');
const { notFoundHandler, errorHandler } = require('./middlewares/error.middleware');

const createApp = (usersInstance = null, sfuServiceInstance = null) => {
  const app = express();

  app.disable('x-powered-by');
  if (config.env === 'production' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // Completely bypass Express for Socket.IO polling and engine requests so Engine.IO has exclusive control
  app.use((req, res, next) => {
    const url = req.url || '';
    if (
      url.startsWith('/socket.io') &&
      !url.startsWith('/socket.io/socket.io.js') &&
      !url.startsWith('/socket.io/socket.io.min.js')
    ) {
      return;
    }
    next();
  });

  // Enterprise security & request correlation headers
  app.use((req, res, next) => {
    if (res.headersSent) {
      return next();
    }
    const requestId = req.headers['x-request-id'] || randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(self), microphone=(self), geolocation=(self), display-capture=(self)'
    );
    if (config.env === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Serve static frontend assets
  app.use(express.static(config.paths.public));

  // Apply HTTP rate limiting to API and upload routes
  const apiRateLimiter = createHttpRateLimiter();

  // Enterprise health & readiness metrics endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      activeRooms: usersInstance ? usersInstance.getActiveRooms().length : 0,
      onlineUsers: usersInstance ? usersInstance.users.length : 0,
      activeSfuSessions: sfuServiceInstance ? sfuServiceInstance.getActiveSessionCount() : 0,
    });
  });

  // Active rooms discovery endpoint
  app.get('/api/rooms', apiRateLimiter, (req, res) => {
    const rooms = usersInstance ? usersInstance.getActiveRooms() : [];
    res.status(200).json({ rooms });
  });

  // WebRTC ICE (STUN/TURN) configuration endpoint
  app.get('/api/rtc-config', apiRateLimiter, (req, res) => {
    res.status(200).json({ iceServers: config.webrtc.iceServers });
  });

  // Provide explicit delivery of Socket.IO client bundle if requested directly
  app.get(['/socket.io/socket.io.js', '/socket.io/socket.io.min.js'], (req, res) => {
    res.type('application/javascript');
    const localLib = path.join(config.paths.public, 'js/libs/socket.io.min.js');
    if (fs.existsSync(localLib)) {
      return res.sendFile(localLib);
    }
    const nodeModulesLib = path.join(__dirname, '../node_modules/socket.io/client-dist/socket.io.min.js');
    return res.sendFile(nodeModulesLib);
  });

  // Favicon handler to prevent 404 console errors
  app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
  });

  // Register file upload and download routes
  app.use('/', apiRateLimiter, routes);

  // 404 and centralized error handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

module.exports = { createApp };
