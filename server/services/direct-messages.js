const { directConversation, sameRoomPeer } = require('../utils/message');
const { UUID } = require('./guest-session');
const { reject } = require('../sockets/events');

function findDirectPeer(users, messageStore, sender, peerId) {
  if (!sender || typeof peerId !== 'string' || !UUID.test(peerId) || peerId === sender.guestId) return null;
  return sameRoomPeer(users, sender, peerId) || messageStore.getDirectPeer(sender, peerId);
}

function requireDirectConversation(users, messageStore, sender, peerId) {
  const recipient = findDirectPeer(users, messageStore, sender, peerId);
  if (!recipient) reject('This direct conversation is unavailable.');
  return { sender, recipient, key: directConversation(sender, recipient) };
}

function publishDirect({ io, users, messageStore }, sender, recipient, event, payload) {
  const key = directConversation(sender, recipient);
  const members = users.getUserList(sender.room);
  const send = (viewer, other) => {
    const sockets = members.filter((user) => user.guestId === viewer.guestId).map((user) => user.id);
    if (!sockets.length) return;
    const peer = { guestId: other.guestId, name: other.name };
    const thread = messageStore.getDirectThread(key, other.guestId);
    io.to(sockets).emit(event, { peer, thread, ...payload });
  };
  send(sender, recipient);
  send(recipient, sender);
}

function saveDirectMessage({ io, users, messageStore }, sender, recipient, message) {
  const saved = messageStore.addDirectMessage(sender, recipient, message);
  publishDirect({ io, users, messageStore }, sender, recipient, 'dm:message', { message: saved });
  return saved;
}

module.exports = { findDirectPeer, publishDirect, requireDirectConversation, saveDirectMessage };
