const { randomUUID } = require('crypto');
const express = require('express');
const config = require('./config');
const routes = require('./routes');
const { createHttpRateLimiter } = require('./middlewares/rate-limit.middleware');
const { notFoundHandler, errorHandler } = require('./middlewares/error.middleware');

const createApp = (usersInstance = null, sfuServiceInstance = null) => {
  const app = express();

  app.disable('x-powered-by');

  // Enterprise security & request correlation headers
  app.use((req, res, next) => {
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

  // Register file upload and download routes
  app.use('/', apiRateLimiter, routes);

  // 404 and centralized error handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

module.exports = { createApp };
