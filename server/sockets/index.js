const { Server } = require('socket.io');
const config = require('../config');
const { FixedWindowRateLimiter } = require('../middlewares/rate-limit.middleware');
const { SfuService } = require('../services/sfu.service');
const { CallsService } = require('../services/calls.service');
const { GroupCallNotifications } = require('../services/group-call-notifications');
const { hasAllowedOrigin } = require('../services/guest-session');
const { createEventRegistrar } = require('./events');
const { registerChatHandlers } = require('./chat.handler');
const { registerPrivateHandlers } = require('./private.handler');
const { registerCallHandlers } = require('./call.handler');
const { registerSfuHandlers } = require('./sfu.handler');
const { logger } = require('../utils/logger');

function initializeSocket(users, messageStore, guestSession, push, PeerConnectionClass) {
  const handshakeLimiter = new FixedWindowRateLimiter({ windowMs: 10000, max: 120 });
  const io = new Server({
    maxHttpBufferSize: 128 * 1024,
    allowRequest: (request, callback) => callback(null, hasAllowedOrigin(request) &&
      Boolean(guestSession.read(request)) && handshakeLimiter.consume(request.socket.remoteAddress).allowed),
  });
  const sfuService = new SfuService(io, PeerConnectionClass);
  const calls = new CallsService(io, users, sfuService, messageStore, push);
  const groupNotifications = new GroupCallNotifications(io, users, sfuService, push);
  sfuService.onRoomCallStarted = (call) => groupNotifications.start(call);
  sfuService.onRoomCallEnded = (id) => groupNotifications.end(id);
  push.canDeliverGroupCall = (id, guestId) => groupNotifications.canDeliver(id, guestId);
  sfuService.onPeerConnected = (id, sessionId) => {
    calls.mediaReady(id);
    const user = users.getUser(id);
    const roomCall = sfuService.getRoomCall(sessionId);
    if (user && roomCall) groupNotifications.silence(user, roomCall.id);
  };
  sfuService.onPeerFailed = (id, sessionId) => {
    if (sessionId.startsWith('private:')) calls.finish(id, sessionId.slice(8), 'failed');
  };

  const socketRateLimiter = new FixedWindowRateLimiter({
    windowMs: config.limits.socketRateLimitWindowMs,
    max: config.limits.socketRateLimitMax,
  });
  const signalingLimiter = new FixedWindowRateLimiter({ windowMs: 10000, max: 80 });

  io.use((socket, next) => {
    const guestId = guestSession.read(socket.request);
    if (io.of('/').sockets.size >= config.limits.maxConnections) return next(new Error('Chat is full. Try again shortly.'));
    if (!guestId) return next(new Error('Open the join page to start a guest session.'));
    socket.data.guestId = guestId;
    return next();
  });

  io.on('connection', (socket) => {
    const leaveCalls = () => {
      calls.leave(socket.id);
      sfuService.leaveAllSessions(socket.id).catch((error) =>
        logger.warn('Could not leave media session', { error: error.name })
      );
    };
    const context = {
      io, socket, users, messageStore, sfuService, calls, push, groupNotifications, leaveCalls, signalingLimiter,
      on: createEventRegistrar(socket, socketRateLimiter),
    };
    socket.on('disconnecting', leaveCalls);
    socket.on('disconnect', () => {
      socketRateLimiter.remove(socket.id);
      signalingLimiter.remove(socket.id);
    });
    registerChatHandlers(context);
    registerPrivateHandlers(context);
    registerCallHandlers(context);
    registerSfuHandlers(context);
  });

  return { io, sfuService, calls, groupNotifications };
}

module.exports = { initializeSocket };
