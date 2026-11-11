const config = require('../config');
const { generateMessage, generateLocationMessage, generateFiles } = require('../utils/message');
const { isRealString } = require('../utils/validation');
const { MessageStore } = require('../utils/message-store');

const defaultMessageStore = new MessageStore();
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '🎉', '🚀', '👀']);

const registerChatHandlers = (
  io,
  socket,
  users,
  messageStore = defaultMessageStore,
  rateLimiter = null
) => {
  const checkAllowed = () => {
    if (!rateLimiter) return true;
    return rateLimiter.consume(socket.id).allowed;
  };

  const broadcastRoomList = () => {
    const activeRooms = users.getActiveRooms();
    if (typeof io.emit === 'function') {
      io.emit('updateRoomList', activeRooms);
    } else {
      activeRooms.forEach((room) => io.to(room).emit('updateRoomList', activeRooms));
    }
  };

  socket.on('join', (params = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};

    if (
      !isRealString(params.name, config.limits.maxNameLength) ||
      !isRealString(params.room, config.limits.maxRoomLength)
    ) {
      return respond('Valid display name and room name (1-50 characters) are required.');
    }

    const name = params.name.trim();
    const canonicalRoom = users.getCanonicalRoom(params.room);

    if (users.isNameTaken(name, canonicalRoom, socket.id)) {
      return respond(`Display name "${name}" is already in use in room "${canonicalRoom}".`);
    }

    socket.join(canonicalRoom);
    users.removeUser(socket.id);
    users.addUser(socket.id, name, canonicalRoom);

    const history = messageStore ? messageStore.getMessages(canonicalRoom) : [];
    if (history.length > 0) {
      socket.emit('roomHistory', history);
    } else {
      socket.emit('newMessage', generateMessage('Admin', 'Welcome to the chat app'));
    }

    io.to(canonicalRoom).emit('updateUserList', users.getUserList(canonicalRoom));
    broadcastRoomList();
    socket.broadcast
      .to(canonicalRoom)
      .emit('newMessage', generateMessage('Admin', `${name} has joined.`));
    return respond();
  });

  socket.on('room:switch', (params = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    const currentUser = users.getUser(socket.id);
    if (!currentUser) {
      return respond('User session not found.');
    }

    if (!isRealString(params.room, config.limits.maxRoomLength)) {
      return respond('Valid group name (1-50 characters) is required.');
    }

    const targetRoom = users.getCanonicalRoom(params.room);
    if (targetRoom.toLowerCase() === currentUser.room.toLowerCase()) {
      return respond(null, { room: currentUser.room });
    }

    if (users.isNameTaken(currentUser.name, targetRoom, socket.id)) {
      return respond(
        `Display name "${currentUser.name}" is already in use in room "${targetRoom}".`
      );
    }

    const previousRoom = currentUser.room;
    if (typeof socket.leave === 'function') {
      socket.leave(previousRoom);
    }
    socket.broadcast.to(previousRoom).emit('typing:update', {
      userId: socket.id,
      name: currentUser.name,
      isTyping: false,
    });

    socket.join(targetRoom);
    users.addUser(socket.id, currentUser.name, targetRoom, currentUser.status);

    io.to(previousRoom).emit('updateUserList', users.getUserList(previousRoom));
    io.to(previousRoom).emit(
      'newMessage',
      generateMessage('Admin', `${currentUser.name} has left.`)
    );

    const history = messageStore ? messageStore.getMessages(targetRoom) : [];
    if (history.length > 0) {
      socket.emit('roomHistory', history);
    }

    io.to(targetRoom).emit('updateUserList', users.getUserList(targetRoom));
    broadcastRoomList();
    socket.emit('newMessage', generateMessage('Admin', `Welcome to #${targetRoom}`));
    socket.broadcast
      .to(targetRoom)
      .emit('newMessage', generateMessage('Admin', `${currentUser.name} has joined.`));

    return respond(null, { room: targetRoom });
  });

  socket.on('presence:update', (payload = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    const updated = users.updateUserStatus(socket.id, payload.status);
    if (!updated) {
      return respond('Invalid presence status.');
    }
    io.to(updated.room).emit('updateUserList', users.getUserList(updated.room));
    return respond(null, updated);
  });

  socket.on('createMessage', (message = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    if (!checkAllowed()) {
      return respond('Rate limit exceeded. Please wait a moment before sending more messages.');
    }

    const user = users.getUser(socket.id);

    if (user && isRealString(message.text, config.limits.maxMessageLength)) {
      const msgObj = generateMessage(user.name, message.text.trim());
      const saved = messageStore ? messageStore.addMessage(user.room, msgObj) : msgObj;
      socket.broadcast.to(user.room).emit('typing:update', {
        userId: socket.id,
        name: user.name,
        isTyping: false,
      });
      io.to(user.room).emit('newMessage', saved);
    }

    return respond();
  });

  socket.on('message:edit', (payload = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    if (!checkAllowed()) return respond('Rate limit exceeded.');

    const user = users.getUser(socket.id);
    if (
      !user ||
      !payload.messageId ||
      !isRealString(payload.text, config.limits.maxMessageLength)
    ) {
      return respond('Invalid edit request.');
    }

    const updated = messageStore
      ? messageStore.editMessage(user.room, payload.messageId, user.name, payload.text.trim())
      : null;

    if (!updated) {
      return respond('Unable to edit message.');
    }

    io.to(user.room).emit('message:edited', {
      messageId: updated.id,
      text: updated.text,
      editedAt: updated.editedAt,
    });
    return respond(null, updated);
  });

  socket.on('message:delete', (payload = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    if (!checkAllowed()) return respond('Rate limit exceeded.');

    const user = users.getUser(socket.id);
    if (!user || !payload.messageId) {
      return respond('Invalid delete request.');
    }

    const deleted = messageStore
      ? messageStore.deleteMessage(user.room, payload.messageId, user.name)
      : false;

    if (!deleted) {
      return respond('Unable to delete message.');
    }

    io.to(user.room).emit('message:deleted', {
      messageId: payload.messageId,
    });
    return respond(null, { messageId: payload.messageId });
  });

  socket.on('message:reaction', (payload = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    if (!checkAllowed()) return respond('Rate limit exceeded.');

    const user = users.getUser(socket.id);
    if (!user || !payload.messageId || !ALLOWED_REACTIONS.has(payload.emoji)) {
      return respond('Invalid reaction.');
    }

    const reactionResult = messageStore
      ? messageStore.toggleReaction(user.room, payload.messageId, payload.emoji, user.name)
      : null;

    if (!reactionResult) {
      return respond('Message not found.');
    }

    io.to(user.room).emit('message:reaction-updated', reactionResult);
    return respond(null, reactionResult);
  });

  socket.on('typing:start', () => {
    const user = users.getUser(socket.id);
    if (!user) return;
    socket.broadcast.to(user.room).emit('typing:update', {
      userId: socket.id,
      name: user.name,
      isTyping: true,
    });
  });

  socket.on('typing:stop', () => {
    const user = users.getUser(socket.id);
    if (!user) return;
    socket.broadcast.to(user.room).emit('typing:update', {
      userId: socket.id,
      name: user.name,
      isTyping: false,
    });
  });

  socket.on('createLocationMessage', (coords = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    if (!checkAllowed()) return respond('Rate limit exceeded.');

    const user = users.getUser(socket.id);
    const lat = Number(coords.latitude);
    const lng = Number(coords.longitude);

    if (user && Number.isFinite(lat) && Number.isFinite(lng)) {
      const locMsg = generateLocationMessage(user.name, lat, lng);
      const saved = messageStore ? messageStore.addMessage(user.room, locMsg) : locMsg;
      io.to(user.room).emit('newLocationMessage', saved);
    }

    return respond();
  });

  socket.on('newFileMessage', (fileInfo = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    if (!checkAllowed()) return respond('Rate limit exceeded.');

    const user = users.getUser(socket.id);
    const filename = fileInfo.filename || fileInfo.key;

    if (user && isRealString(filename, 500)) {
      const fileMsg = generateFiles(user.name, filename.trim());
      const saved = messageStore ? messageStore.addMessage(user.room, fileMsg) : fileMsg;
      io.to(user.room).emit('newFileMessage', saved);
    }

    return respond();
  });

  socket.on('disconnect', () => {
    if (rateLimiter) {
      rateLimiter.remove(socket.id);
    }
    const user = users.removeUser(socket.id);

    if (user) {
      socket.broadcast.to(user.room).emit('typing:update', {
        userId: socket.id,
        name: user.name,
        isTyping: false,
      });
      io.to(user.room).emit('updateUserList', users.getUserList(user.room));
      broadcastRoomList();
      io.to(user.room).emit('newMessage', generateMessage('Admin', `${user.name} has left.`));
    }
  });
};

module.exports = { registerChatHandlers, ALLOWED_REACTIONS };
