const { randomUUID } = require('node:crypto');

const generateMessage = (from, text) => ({
  id: randomUUID(),
  type: 'text',
  from,
  text,
  createdAt: Date.now(),
});

const generateLocationMessage = (from, latitude, longitude) => ({
  id: randomUUID(),
  type: 'location',
  from,
  url: `https://www.google.com/maps?q=${latitude},${longitude}`,
  createdAt: Date.now(),
});

const generateFiles = (from, id, filename) => ({
  id,
  type: 'file',
  from,
  filename,
  url: `/api/files/${id}`,
  createdAt: Date.now(),
});

const roomChannel = (room) => `chat:${room.trim().toLowerCase()}`;
const directConversation = (sender, recipient) =>
  JSON.stringify(['dm', roomChannel(sender.room), ...[sender.guestId, recipient.guestId].sort()]);

const sameRoomPeer = (users, sender, id) => {
  const peer = typeof id === 'string' && users.getUser(id);
  return sender && peer && peer.room === sender.room && peer.guestId !== sender.guestId ? peer : null;
};

const validCoordinates = (latitude, longitude) =>
  Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
  Number.isFinite(longitude) && Math.abs(longitude) <= 180;

module.exports = { generateMessage, generateLocationMessage, generateFiles, roomChannel, directConversation, sameRoomPeer, validCoordinates };
