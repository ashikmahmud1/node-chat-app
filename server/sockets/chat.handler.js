const config = require('../config');
const { generateMessage, generateLocationMessage, roomChannel, validCoordinates, messagePreview } = require('../utils/message');
const { isRealString } = require('../utils/validation');
const { reject, validateReply } = require('./events');
const { publishDirect, requireDirectConversation } = require('../services/direct-messages');

const ALLOWED_REACTIONS = new Set(['👍', '❤️', '🎉', '🚀', '👀']);

function registerChatHandlers({ io, socket, users, messageStore, on, leaveCalls, sfuService }) {
  const requireUser = () => {
    const user = users.getUser(socket.id);
    if (!user) reject('Join a group first.');
    return user;
  };
  const messageContext = (user, peerId) => {
    if (peerId === undefined) {
      const key = roomChannel(user.room);
      return { key, publish: (event, payload) => io.to(key).emit(event, payload) };
    }
    const { key, recipient } = requireDirectConversation(users, messageStore, user, peerId);
    return { key, publish: (event, payload) => publishDirect({ io, users, messageStore }, user, recipient, event, payload) };
  };

  const broadcastPresence = (room) => io.to(roomChannel(room)).emit('updateUserList', users.getUserList(room));
  const broadcastRooms = () => io.emit('updateRoomList', users.getActiveRooms());

  const snapshot = (user, messages) => ({
    user,
    messages,
    historyLimit: messageStore.limit,
    users: users.getUserList(user.room),
    directThreads: messageStore.getDirectThreads(user),
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
    messageStore.rememberDirectName(user);
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

  on('createMessage', ({ text, replyTo }) => {
    const user = requireUser();
    if (!isRealString(text, config.limits.maxMessageLength)) reject('Enter a message between 1 and 2,000 characters.');
    const channel = roomChannel(user.room);
    const message = messageStore.addMessage(channel, {
      ...generateMessage(user.name, text.trim()),
      ...validateReply(messageStore, channel, replyTo),
      authorId: user.guestId,
    });
    socket.to(channel).emit('typing:update', { userId: socket.id, isTyping: false });
    io.to(channel).emit('newMessage', message);
    return { id: message.id };
  });

  on('createLocationMessage', ({ latitude, longitude, replyTo }) => {
    const user = requireUser();
    if (!validCoordinates(latitude, longitude)) reject('Invalid location.');
    const channel = roomChannel(user.room);
    const message = messageStore.addMessage(channel, {
      ...generateLocationMessage(user.name, latitude, longitude),
      ...validateReply(messageStore, channel, replyTo),
      authorId: user.guestId,
    });
    io.to(channel).emit('newMessage', message);
    return { id: message.id };
  });

  on('message:edit', ({ peerId, messageId, text }) => {
    const user = requireUser();
    if (typeof messageId !== 'string' || !isRealString(text, config.limits.maxMessageLength)) reject('Invalid edit request.');
    const { key, publish } = messageContext(user, peerId);
    const updated = messageStore.editMessage(key, messageId, user.guestId, text.trim());
    if (!updated) reject('Unable to edit message.');
    publish('message:edited', { messageId, text: updated.text, editedAt: updated.editedAt, quote: messagePreview(updated) });
  });

  on('message:delete', ({ peerId, messageId }) => {
    const user = requireUser();
    const { key, publish } = messageContext(user, peerId);
    if (typeof messageId !== 'string' || !messageStore.deleteMessage(key, messageId, user.guestId)) reject('Unable to delete message.');
    publish('message:deleted', { messageId });
  });

  on('message:reaction', ({ peerId, messageId, emoji }) => {
    const user = requireUser();
    if (typeof messageId !== 'string' || !ALLOWED_REACTIONS.has(emoji)) reject('Invalid reaction.');
    const { key, publish } = messageContext(user, peerId);
    const result = messageStore.toggleReaction(key, messageId, emoji, user);
    if (!result) reject('Unable to update reaction.');
    publish('message:reaction-updated', result);
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
