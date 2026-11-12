const config = require('../config');
const { UUID } = require('../services/guest-session');
const { generateMessage, generateLocationMessage, validCoordinates } = require('../utils/message');
const { isRealString } = require('../utils/validation');
const { reject, validateReply } = require('./events');
const { publishDirect, requireDirectConversation, saveDirectMessage } = require('../services/direct-messages');

function registerPrivateHandlers({ io, socket, users, messageStore, push, on, signalingLimiter }) {
  const conversation = (peerId) => requireDirectConversation(users, messageStore, users.getUser(socket.id), peerId);

  const save = ({ sender, recipient }, message) => {
    const saved = saveDirectMessage({ io, users, messageStore, push }, sender, recipient, message);
    return { id: saved.id };
  };

  on('dm:history', ({ peerId, before }) => {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) reject('Invalid history cursor.');
    return messageStore.getDirectPage(conversation(peerId).key, before);
  });

  on('dm:read', ({ peerId, messageIds }) => {
    const { key, sender, recipient } = conversation(peerId);
    if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 50 ||
        messageIds.some((id) => typeof id !== 'string' || !UUID.test(id))) reject('Invalid read receipt.');
    const { receipts, changed } = messageStore.markDirectRead(key, recipient.guestId, new Set(messageIds));
    if (changed) publishDirect({ io, users, messageStore }, sender, recipient, 'dm:read', { receipts });
    return receipts;
  }, signalingLimiter);

  on('dm:send', ({ peerId, text, replyTo }) => {
    const pair = conversation(peerId);
    if (!isRealString(text, config.limits.maxMessageLength)) reject('Enter a message between 1 and 2,000 characters.');
    return save(pair, { ...generateMessage(pair.sender.name, text.trim()), ...validateReply(messageStore, pair.key, replyTo) });
  });

  on('dm:location', ({ peerId, latitude, longitude, replyTo }) => {
    const pair = conversation(peerId);
    if (!validCoordinates(latitude, longitude)) reject('Invalid location.');
    return save(pair, {
      ...generateLocationMessage(pair.sender.name, latitude, longitude),
      ...validateReply(messageStore, pair.key, replyTo),
    });
  });

  on('dm:typing', ({ peerId, isTyping }) => {
    const { sender, recipient } = conversation(peerId);
    if (!recipient.id || typeof isTyping !== 'boolean') return;
    socket.to(recipient.id).emit('dm:typing', { userId: sender.guestId, name: sender.name, isTyping });
  });
}

module.exports = { registerPrivateHandlers };
