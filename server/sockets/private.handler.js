const { generateLocationMessage } = require('../utils/message');
const { isRealString } = require('../utils/validation');

const registerPrivateHandlers = (io, socket, users) => {
  socket.on('privateMessageWindow', (target = {}) => {
    const sender = users.getUser(socket.id);
    if (!sender || !target.id) return;

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

  socket.on('createPrivateMessage', (payload = {}) => {
    const sender = users.getUser(socket.id);
    if (!sender || !payload.userid || !isRealString(payload.message)) return;

    socket.broadcast.to(payload.userid).emit('newPrivateMessage', {
      message: payload.message.trim(),
      user: sender,
      createdAt: Date.now(),
    });
  });

  socket.on('privateMessageSendSuccessful', (payload = {}) => {
    if (!payload.userid) return;
    const originalSender = users.getUser(payload.userid);
    if (!originalSender) return;

    const messageObject = {
      message: payload.message,
      user: originalSender,
      id: socket.id,
      createdAt: Date.now(),
    };

    socket.broadcast.to(payload.userid).emit('privateMessageSuccessfulAdd', messageObject);
  });

  socket.on('newPrivateFileMessage', (info = {}) => {
    const sender = users.getUser(socket.id);
    if (!sender || !info.userid || !info.fileInfo) return;

    socket.broadcast.to(info.userid).emit('newPrivateFileMessage', {
      user: sender,
      fileInfo: info.fileInfo,
      createdAt: Date.now(),
    });
  });

  socket.on('privateFileSendSuccessful', (info = {}) => {
    if (!info.user || !info.user.id || !info.fileInfo) return;
    const originalSender = users.getUser(info.user.id);
    if (!originalSender) return;

    socket.broadcast.to(info.user.id).emit('privateFileSendSuccessful', {
      filename: info.fileInfo.filename,
      user: originalSender,
      id: socket.id,
      createdAt: Date.now(),
    });
  });

  socket.on('createPrivateLocationMessage', (coords = {}) => {
    const sender = users.getUser(socket.id);
    if (!sender || !coords.userid || coords.latitude === undefined || coords.longitude === undefined) {
      return;
    }

    const location = generateLocationMessage(sender.name, coords.latitude, coords.longitude);
    socket.broadcast.to(coords.userid).emit('newPrivateLocationMessage', {
      location,
      user: sender,
    });
  });

  socket.on('locationMessageSuccessful', (message = {}) => {
    if (!message.user || !message.user.id) return;

    const newMessage = {
      message,
      id: socket.id,
    };

    socket.broadcast.to(message.user.id).emit('locationMessageSuccessful', newMessage);
  });
};

module.exports = { registerPrivateHandlers };
