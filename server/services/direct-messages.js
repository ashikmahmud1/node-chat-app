const { directConversation } = require('../utils/message');

function publishDirect(io, users, sender, recipient, message) {
  for (const user of users.getUserList(sender.room)) {
    if (user.guestId === sender.guestId) io.to(user.id).emit('dm:message', { peer: recipient, message });
    if (user.guestId === recipient.guestId) io.to(user.id).emit('dm:message', { peer: sender, message });
  }
}

function saveDirectMessage({ io, users, messageStore }, sender, recipient, message) {
  const saved = messageStore.addMessage(directConversation(sender, recipient), { ...message, authorId: sender.guestId });
  publishDirect(io, users, sender, recipient, saved);
  return saved;
}

module.exports = { saveDirectMessage };
