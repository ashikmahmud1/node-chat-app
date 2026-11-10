const { Server } = require('socket.io');
const config = require('../config');
const { Users } = require('../utils/users');
const { MessageStore } = require('../utils/message-store');
const { SlidingWindowRateLimiter } = require('../middlewares/rate-limit.middleware');
const { SfuService } = require('../services/sfu.service');
const { registerChatHandlers } = require('./chat.handler');
const { registerPrivateHandlers } = require('./private.handler');
const { registerCallHandlers } = require('./call.handler');
const { registerSfuHandlers } = require('./sfu.handler');

const initializeSocket = (httpServer, options = {}, existingUsers = null, existingMessageStore = null) => {
  const io = new Server(httpServer, {
    maxHttpBufferSize: 1e7, // 10 MB buffer
    ...options,
  });
  const users = existingUsers || new Users();
  const messageStore = existingMessageStore || new MessageStore();
  const sfuService = new SfuService(io, users);
  const socketRateLimiter = new SlidingWindowRateLimiter({
    windowMs: config.limits.socketRateLimitWindowMs,
    max: config.limits.socketRateLimitMax,
  });

  io.on('connection', (socket) => {
    registerChatHandlers(io, socket, users, messageStore, socketRateLimiter);
    registerPrivateHandlers(io, socket, users, socketRateLimiter);
    registerCallHandlers(io, socket, users);
    registerSfuHandlers(io, socket, users, sfuService);
  });

  return { io, users, messageStore, sfuService, socketRateLimiter };
};

module.exports = { initializeSocket };
