const config = require('../config');
const { generateMessage, generateLocationMessage, roomChannel, validCoordinates } = require('../utils/message');
const { isRealString } = require('../utils/validation');
const { reject } = require('./events');

const ALLOWED_REACTIONS = new Set(['👍', '❤️', '🎉', '🚀', '👀']);

function registerChatHandlers({ io, socket, users, messageStore, on, leaveCalls, sfuService }) {
  const requireUser = () => {
    const user = users.getUser(socket.id);
    if (!user) reject('Join a group first.');
    return user;
  };

  const broadcastPresence = (room) => io.to(roomChannel(room)).emit('updateUserList', users.getUserList(room));
  const broadcastRooms = () => io.emit('updateRoomList', users.getActiveRooms());

  const snapshot = (user, messages) => ({
    user,
    messages,
    historyLimit: messageStore.limit,
    users: users.getUserList(user.room),
    participants: sfuService.getSessionParticipants(`room:${roomChannel(user.room)}`),
  });

  const resolveRoom = (name, room) => {
    if (!isRealString(room, config.limits.maxRoomLength)) reject('Enter a group name between 1 and 50 characters.');
    const canonical = users.getCanonicalRoom(room);
    const members = users.getUserList(canonical);
    const occupant = members.find((member) => member.id !== socket.id && member.name.toLowerCase() === name.trim().toLowerCase());
    if (occupant && occupant.guestId !== socket.data.guestId) reject(`The display name "${name}" is already in use in this group.`);
    if (!occupant && members.length >= config.limits.maxRoomUsers) reject('This group is full.');
    return { room: canonical, previousConnection: occupant?.id };

  };

  function enter(name, { room, previousConnection }, status, messages) {
    if (previousConnection) io.sockets.sockets.get(previousConnection)?.disconnect(true);
    socket.join(roomChannel(room));
    const user = users.addUser(socket.id, name, room, status, socket.data.guestId);
    const state = snapshot(user, messages);
    // A single snapshot establishes the context before live events arrive.
    socket.emit('room:state', state);
    broadcastPresence(room);
    broadcastRooms();
    return state.user;
  }

  on('join', ({ name, room }) => {
    if (users.getUser(socket.id)) reject('Already joined. Use group switching.');
    if (!isRealString(name, config.limits.maxNameLength)) reject('Enter a display name between 1 and 50 characters.');
    const target = resolveRoom(name, room);
    const messages = messageStore.getMessages(roomChannel(target.room));
    return enter(name.trim(), target, 'online', messages);
  });

  const depart = (user) => {
    broadcastPresence(user.room);
    socket.to(roomChannel(user.room)).emit('typing:update', { userId: socket.id, isTyping: false });
  };

  on('room:switch', ({ room }) => {
    const current = requireUser();
    if (typeof room === 'string' && roomChannel(room) === roomChannel(current.room)) return current;
    const target = resolveRoom(current.name, room);
    const messages = messageStore.getMessages(roomChannel(target.room));
    leaveCalls();
    socket.leave(roomChannel(current.room));
    users.removeUser(socket.id);
    depart(current);
    return enter(current.name, target, current.status, messages);
  });

  on('presence:update', ({ status }) => {
    requireUser();
    const user = users.updateUserStatus(socket.id, status);
    if (!user) reject('Invalid presence status.');
    broadcastPresence(user.room);
    return user;
  });

  on('createMessage', ({ text }) => {
    const user = requireUser();
    if (!isRealString(text, config.limits.maxMessageLength)) reject('Enter a message between 1 and 2,000 characters.');
    const channel = roomChannel(user.room);
    const message = messageStore.addMessage(channel, { ...generateMessage(user.name, text.trim()), authorId: user.guestId });
    socket.to(channel).emit('typing:update', { userId: socket.id, isTyping: false });
    io.to(channel).emit('newMessage', message);
    return { id: message.id };
  });

  on('createLocationMessage', ({ latitude, longitude }) => {
    const user = requireUser();
    if (!validCoordinates(latitude, longitude)) reject('Invalid location.');
    const channel = roomChannel(user.room);
    const message = messageStore.addMessage(channel, { ...generateLocationMessage(user.name, latitude, longitude), authorId: user.guestId });
    io.to(channel).emit('newMessage', message);
    return { id: message.id };
  });

  on('message:edit', ({ messageId, text }) => {
    const user = requireUser();
    if (typeof messageId !== 'string' || !isRealString(text, config.limits.maxMessageLength)) reject('Invalid edit request.');
    const channel = roomChannel(user.room);
    const updated = messageStore.editMessage(channel, messageId, user.guestId, text.trim());
    if (!updated) reject('Unable to edit message.');
    io.to(channel).emit('message:edited', { messageId, text: updated.text, editedAt: updated.editedAt });
  });

  on('message:delete', ({ messageId }) => {
    const user = requireUser();
    const channel = roomChannel(user.room);
    if (typeof messageId !== 'string' || !messageStore.deleteMessage(channel, messageId, user.guestId)) reject('Unable to delete message.');
    io.to(channel).emit('message:deleted', { messageId });
  });

  on('message:reaction', ({ messageId, emoji }) => {
    const user = requireUser();
    if (typeof messageId !== 'string' || !ALLOWED_REACTIONS.has(emoji)) reject('Invalid reaction.');
    const channel = roomChannel(user.room);
    const result = messageStore.toggleReaction(channel, messageId, emoji, user);
    if (!result) reject('Unable to update reaction.');
    io.to(channel).emit('message:reaction-updated', result);
  });

  on('typing:update', ({ isTyping }) => {
    const user = requireUser();
    if (typeof isTyping !== 'boolean') return;
    socket.to(roomChannel(user.room)).emit('typing:update', { userId: socket.id, name: user.name, isTyping });
  });

  socket.on('disconnect', () => {
    const user = users.removeUser(socket.id);
    if (!user) return;
    depart(user);
    broadcastRooms();
  });
}

module.exports = { registerChatHandlers };
