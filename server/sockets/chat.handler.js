const config = require('../config');
const { generateMessage, generateLocationMessage, generateFiles } = require('../utils/message');
const { isRealString } = require('../utils/validation');

const registerChatHandlers = (io, socket, users) => {
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

    io.to(canonicalRoom).emit('updateUserList', users.getUserList(canonicalRoom));
    socket.emit('newMessage', generateMessage('Admin', 'Welcome to the chat app'));
    socket.broadcast
      .to(canonicalRoom)
      .emit('newMessage', generateMessage('Admin', `${name} has joined.`));
    return respond();
  });

  socket.on('createMessage', (message = {}, callback = () => {}) => {
    const user = users.getUser(socket.id);

    if (user && isRealString(message.text, config.limits.maxMessageLength)) {
      io.to(user.room).emit('newMessage', generateMessage(user.name, message.text.trim()));
    }

    if (typeof callback === 'function') {
      callback();
    }
  });

  socket.on('createLocationMessage', (coords = {}, callback = () => {}) => {
    const user = users.getUser(socket.id);
    const lat = Number(coords.latitude);
    const lng = Number(coords.longitude);

    if (user && Number.isFinite(lat) && Number.isFinite(lng)) {
      io.to(user.room).emit(
        'newLocationMessage',
        generateLocationMessage(user.name, lat, lng)
      );
    }

    if (typeof callback === 'function') {
      callback();
    }
  });

  socket.on('newFileMessage', (fileInfo = {}, callback = () => {}) => {
    const user = users.getUser(socket.id);
    const filename = fileInfo.filename || fileInfo.key;

    if (user && isRealString(filename, 500)) {
      io.to(user.room).emit('newFileMessage', generateFiles(user.name, filename.trim()));
    }

    if (typeof callback === 'function') {
      callback();
    }
  });

  socket.on('disconnect', () => {
    const user = users.removeUser(socket.id);

    if (user) {
      io.to(user.room).emit('updateUserList', users.getUserList(user.room));
      io.to(user.room).emit('newMessage', generateMessage('Admin', `${user.name} has left.`));
    }
  });
};

module.exports = { registerChatHandlers };
