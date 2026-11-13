const { randomUUID } = require('node:crypto');
const path = require('node:path');
const express = require('express');
const config = require('./config');
const { createHttpRateLimiter } = require('./middlewares/rate-limit.middleware');
const { notFoundHandler, errorHandler } = require('./middlewares/error.middleware');
const { createPushRouter } = require('./controllers/push.controller');

function createApp({ users, guestSession, files, messageStore, push, calls, groupNotifications }) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set({
      'X-Request-Id': req.requestId,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), display-capture=(self)',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (config.publicOrigin.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
  app.use('/api', createHttpRateLimiter());
  app.post('/api/session', guestSession.establish);
  app.use('/api/push', createPushRouter({ guestSession, messageStore, push, calls, groupNotifications }));
  app.get('/api/rooms', (req, res) => res.set('Cache-Control', 'no-store').json({ rooms: users.getActiveRooms() }));
  app.get('/api/rtc-config', (req, res) => {
    const guestId = guestSession.read(req);
    if (!guestId) return res.status(401).json({ error: 'Join to start a call.' });
    return res.set('Cache-Control', 'no-store').json({
      iceServers: config.webrtc.getIceServers(guestId),
      iceTransportPolicy: config.webrtc.iceTransportPolicy,
    });
  });
  app.post('/api/files', files.uploadFile);
  app.get('/api/files/:id', files.downloadFile);

  const iconPath = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
  app.get('/assets/icons/css/all.min.css', (req, res) => res.sendFile(path.join(iconPath, 'css/all.min.css')));
  app.use('/assets/icons/webfonts', express.static(path.join(iconPath, 'webfonts')));
  app.get('/assets/jquery.min.js', (req, res) => res.sendFile(path.join(path.dirname(require.resolve('jquery')), 'jquery.min.js')));
  app.get('/assets/mustache.min.js', (req, res) => res.sendFile(require.resolve('mustache/mustache.min.js')));
  app.use(express.static(config.paths.public));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
