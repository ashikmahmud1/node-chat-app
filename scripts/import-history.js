const fs = require('node:fs');
const { MessageStore } = require('../server/utils/message-store');
const { generateLocationMessage, roomChannel, validCoordinates } = require('../server/utils/message');
const { isRealString } = require('../server/utils/validation');
const { UUID } = require('../server/services/guest-session');
const config = require('../server/config');

const source = process.argv[2];
if (!source) throw new Error('Pass the path to the exported message-history.json file.');

const records = JSON.parse(fs.readFileSync(source, 'utf8'));
if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid history export.');

function importMessage(entry) {
  if (!entry || !UUID.test(entry.id) || !isRealString(entry.from, config.limits.maxNameLength) ||
      !Number.isSafeInteger(entry.createdAt) || entry.createdAt > Date.now() ||
      entry.createdAt < Date.now() - config.limits.retentionMs) return null;
  const base = { id: entry.id, from: entry.from, createdAt: entry.createdAt };
  if (entry.type === 'text' && isRealString(entry.text, config.limits.maxMessageLength)) {
    return { ...base, type: 'text', text: entry.text, edited: entry.edited === true };
  }
  if (entry.type === 'location') {
    const coordinate = /^https:\/\/www\.google\.com\/maps\?q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(entry.url);
    if (!coordinate) return null;
    const latitude = Number(coordinate[1]);
    const longitude = Number(coordinate[2]);
    if (validCoordinates(latitude, longitude)) return { ...generateLocationMessage(base.from, latitude, longitude), ...base };
  }
  return null;
}

const store = new MessageStore();
let added = 0;
let skipped = 0;
try {
  for (const [room, entries] of Object.entries(records)) {
    if (!isRealString(room, config.limits.maxRoomLength) || !Array.isArray(entries)) {
      skipped += Array.isArray(entries) ? entries.length : 1;
      continue;
    }
    const channel = roomChannel(room);
    const messages = entries.map(importMessage).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt)
      .slice(-config.limits.maxRoomHistory);
    skipped += entries.length - messages.length;
    for (const message of messages) {
      if (store.getMessage(channel, message.id)) {
        skipped += 1;
        continue;
      }
      store.addMessage(channel, message);
      added += 1;
    }
  }
  process.stdout.write(`Imported ${added} messages. Skipped ${skipped} records.\n`);
} finally {
  store.close();
}
