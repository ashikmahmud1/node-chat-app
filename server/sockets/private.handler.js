const config = require('../config');
const { generateMessage, generateLocationMessage, directConversation, sameRoomPeer, validCoordinates } = require('../utils/message');
const { isRealString } = require('../utils/validation');
const { reject } = require('./events');
const { saveDirectMessage } = require('../services/direct-messages');

function registerPrivateHandlers({ io, socket, users, messageStore, on }) {
  const conversation = (peerId) => {
    const sender = users.getUser(socket.id);
    const recipient = sameRoomPeer(users, sender, peerId);
    if (!recipient) reject('This person is no longer in your group.');
    return { sender, recipient, key: directConversation(sender, recipient) };
  };

  const save = ({ sender, recipient }, message) => {
    const saved = saveDirectMessage({ io, users, messageStore }, sender, recipient, message);
    return { id: saved.id };
  };

  on('dm:history', ({ peerId }) => messageStore.getMessages(conversation(peerId).key));

  on('dm:send', ({ peerId, text }) => {
    const pair = conversation(peerId);
    if (!isRealString(text, config.limits.maxMessageLength)) reject('Enter a message between 1 and 2,000 characters.');
    return save(pair, generateMessage(pair.sender.name, text.trim()));
  });

  on('dm:location', ({ peerId, latitude, longitude }) => {
    const pair = conversation(peerId);
    if (!validCoordinates(latitude, longitude)) reject('Invalid location.');
    return save(pair, generateLocationMessage(pair.sender.name, latitude, longitude));
  });

  on('dm:typing', ({ peerId, isTyping }) => {
    const { sender, recipient } = conversation(peerId);
    if (typeof isTyping !== 'boolean') return;
    socket.to(recipient.id).emit('dm:typing', { userId: sender.id, name: sender.name, isTyping });
  });
}

module.exports = { registerPrivateHandlers };
