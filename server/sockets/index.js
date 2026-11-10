const { Server } = require('socket.io');
const { Users } = require('../utils/users');
const { registerChatHandlers } = require('./chat.handler');
const { registerPrivateHandlers } = require('./private.handler');
const { registerCallHandlers } = require('./call.handler');

const initializeSocket = (httpServer, options = {}) => {
  const io = new Server(httpServer, {
    maxHttpBufferSize: 1e7, // 10 MB buffer for audio/video stream chunks
    ...options,
  });
  const users = new Users();

  io.on('connection', (socket) => {
    registerChatHandlers(io, socket, users);
    registerPrivateHandlers(io, socket, users);
    registerCallHandlers(io, socket, users);
  });

  return { io, users };
};

module.exports = { initializeSocket };
