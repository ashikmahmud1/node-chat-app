const { generateMessage, generateLocationMessage, generateFiles } = require('../utils/message');
const { isRealString } = require('../utils/validation');

const registerChatHandlers = (io, socket, users) => {
  socket.on('join', (params = {}, callback = () => {}) => {
    if (!isRealString(params.name) || !isRealString(params.room)) {
      return callback('Name and room name are required.');
    }

    const name = params.name.trim();
    const room = params.room.trim();

    socket.join(room);
    users.removeUser(socket.id);
    users.addUser(socket.id, name, room);

    io.to(room).emit('updateUserList', users.getUserList(room));
    socket.emit('newMessage', generateMessage('Admin', 'Welcome to the chat app'));
    socket.broadcast.to(room).emit('newMessage', generateMessage('Admin', `${name} has joined.`));
    return callback();
  });

  socket.on('createMessage', (message = {}, callback = () => {}) => {
    const user = users.getUser(socket.id);

    if (user && isRealString(message.text)) {
      io.to(user.room).emit('newMessage', generateMessage(user.name, message.text.trim()));
    }

    if (typeof callback === 'function') {
      callback();
    }
  });

  socket.on('createLocationMessage', (coords = {}) => {
    const user = users.getUser(socket.id);

    if (user && coords.latitude !== undefined && coords.longitude !== undefined) {
      io.to(user.room).emit(
        'newLocationMessage',
        generateLocationMessage(user.name, coords.latitude, coords.longitude)
      );
    }
  });

  socket.on('newFileMessage', (fileInfo = {}) => {
    const user = users.getUser(socket.id);
    const filename = fileInfo.filename || fileInfo.key;

    if (user && isRealString(filename)) {
      io.to(user.room).emit('newFileMessage', generateFiles(user.name, filename));
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
