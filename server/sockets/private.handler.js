const config = require('../config');
const { generateLocationMessage } = require('../utils/message');
const { isRealString } = require('../utils/validation');

const registerPrivateHandlers = (io, socket, users, rateLimiter = null) => {
  const checkAllowed = () => {
    if (!rateLimiter) return true;
    return rateLimiter.consume(socket.id).allowed;
  };

  socket.on('privateMessageWindow', (target = {}) => {
    const sender = users.getUser(socket.id);
    if (!sender || !target.id || target.id === socket.id) return;

    const targetUser = users.getUser(target.id);
    if (!targetUser) return;

    socket.broadcast.to(target.id).emit('notifyUser', {
      user: sender,
      otherUser: target.id,
    });
  });

  socket.on('private_connection_successful', (payload = {}) => {
    if (!payload.user || !payload.user.id || !payload.otherUserId) return;

    const otherUser = users.getUser(payload.otherUserId);
    if (!otherUser) return;

    socket.broadcast.to(payload.user.id).emit('openChatWindow', {
      user: otherUser,
    });
  });

  socket.on('private:typing', (payload = {}) => {
    const sender = users.getUser(socket.id);
    if (!sender || !payload.userid || payload.userid === socket.id) return;

    socket.broadcast.to(payload.userid).emit('private:typing', {
      userId: socket.id,
      name: sender.name,
      isTyping: Boolean(payload.isTyping),
    });
  });

  socket.on('createPrivateMessage', (payload = {}) => {
    if (!checkAllowed()) return;
    const sender = users.getUser(socket.id);
    if (
      !sender ||
      !payload.userid ||
      payload.userid === socket.id ||
      !isRealString(payload.message, config.limits.maxMessageLength)
    ) {
      return;
    }

    const recipient = users.getUser(payload.userid);
    if (!recipient) return;

    socket.broadcast.to(payload.userid).emit('private:typing', {
      userId: socket.id,
      name: sender.name,
      isTyping: false,
    });

    socket.broadcast.to(payload.userid).emit('newPrivateMessage', {
      message: payload.message.trim(),
      user: sender,
      createdAt: Date.now(),
    });
  });

  socket.on('privateMessageSendSuccessful', (payload = {}) => {
    if (!payload.userid || !isRealString(payload.message, config.limits.maxMessageLength)) return;
    const originalSender = users.getUser(payload.userid);
    if (!originalSender) return;

    const messageObject = {
      message: payload.message.trim(),
      user: originalSender,
      id: socket.id,
      createdAt: Date.now(),
    };

    socket.broadcast.to(payload.userid).emit('privateMessageSuccessfulAdd', messageObject);
  });

  socket.on('newPrivateFileMessage', (info = {}) => {
    if (!checkAllowed()) return;
    const sender = users.getUser(socket.id);
    if (!sender || !info.userid || info.userid === socket.id || !info.fileInfo) return;

    const recipient = users.getUser(info.userid);
    if (!recipient) return;

    const filename = info.fileInfo.filename || info.fileInfo.key;
    if (!isRealString(filename, 500)) return;

    socket.broadcast.to(info.userid).emit('newPrivateFileMessage', {
      user: sender,
      fileInfo: {
        ...info.fileInfo,
        filename: filename.trim(),
      },
      createdAt: Date.now(),
    });
  });

  socket.on('privateFileSendSuccessful', (info = {}) => {
    if (!info.user || !info.user.id || !info.fileInfo) return;
    const originalSender = users.getUser(info.user.id);
    if (!originalSender) return;

    const filename = info.fileInfo.filename || info.fileInfo.key;
    if (!isRealString(filename, 500)) return;

    socket.broadcast.to(info.user.id).emit('privateFileSendSuccessful', {
      filename: filename.trim(),
      user: originalSender,
      id: socket.id,
      createdAt: Date.now(),
    });
  });

  socket.on('createPrivateLocationMessage', (coords = {}) => {
    if (!checkAllowed()) return;
    const sender = users.getUser(socket.id);
    const lat = Number(coords.latitude);
    const lng = Number(coords.longitude);

    if (
      !sender ||
      !coords.userid ||
      coords.userid === socket.id ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return;
    }

    const recipient = users.getUser(coords.userid);
    if (!recipient) return;

    const location = generateLocationMessage(sender.name, lat, lng);
    socket.broadcast.to(coords.userid).emit('newPrivateLocationMessage', {
      location,
      user: sender,
    });
  });

  socket.on('locationMessageSuccessful', (message = {}) => {
    if (!message.user || !message.user.id || !message.location) return;

    const newMessage = {
      message,
      id: socket.id,
    };

    socket.broadcast.to(message.user.id).emit('locationMessageSuccessful', newMessage);
  });
};

module.exports = { registerPrivateHandlers };
