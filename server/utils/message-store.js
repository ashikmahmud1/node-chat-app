const fs = require('fs');
const path = require('path');
const config = require('../config');
const { logger } = require('./logger');

class MessageStore {
  constructor(
    maxMessagesPerRoom = config.limits.maxRoomHistory,
    persistPath = config.env === 'test'
      ? null
      : path.join(config.paths.uploads, 'message-history.json')
  ) {
    this.maxMessagesPerRoom = maxMessagesPerRoom;
    this.persistPath = persistPath;
    // Map<normalizedRoom, Array<MessageObject>>
    this.rooms = new Map();
    this.loadFromDisk();
  }

  normalizeKey(room) {
    return typeof room === 'string' ? room.trim().toLowerCase() : '';
  }

  loadFromDisk() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        Object.entries(parsed).forEach(([key, messages]) => {
          if (Array.isArray(messages)) {
            this.rooms.set(key, messages.slice(-this.maxMessagesPerRoom));
          }
        });
      }
    } catch (err) {
      logger.warn('Failed to load persisted message history', { error: err.message });
    }
  }

  saveToDisk() {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serializable = {};
      for (const [key, messages] of this.rooms.entries()) {
        serializable[key] = messages;
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(serializable, null, 2), 'utf8');
    } catch (err) {
      logger.warn('Failed to persist message history', { error: err.message });
    }
  }

  addMessage(room, message) {
    const key = this.normalizeKey(room);
    if (!key || !message) return null;

    if (!this.rooms.has(key)) {
      this.rooms.set(key, []);
    }

    const enriched = {
      reactions: {},
      edited: false,
      ...message,
    };

    const list = this.rooms.get(key);
    list.push(enriched);

    if (list.length > this.maxMessagesPerRoom) {
      list.splice(0, list.length - this.maxMessagesPerRoom);
    }

    this.saveToDisk();
    return enriched;
  }

  editMessage(room, messageId, senderName, newText) {
    const key = this.normalizeKey(room);
    if (!key || !this.rooms.has(key)) return null;

    const list = this.rooms.get(key);
    const msg = list.find((m) => m.id === messageId);
    if (!msg || msg.from !== senderName || msg.type !== 'text') return null;

    msg.text = newText;
    msg.edited = true;
    msg.editedAt = Date.now();
    this.saveToDisk();
    return msg;
  }

  deleteMessage(room, messageId, senderName) {
    const key = this.normalizeKey(room);
    if (!key || !this.rooms.has(key)) return false;

    const list = this.rooms.get(key);
    const index = list.findIndex((m) => m.id === messageId && m.from === senderName);
    if (index === -1) return false;

    list.splice(index, 1);
    this.saveToDisk();
    return true;
  }

  toggleReaction(room, messageId, emoji, userName) {
    const key = this.normalizeKey(room);
    if (!key || !this.rooms.has(key) || !emoji || !userName) return null;

    const list = this.rooms.get(key);
    const msg = list.find((m) => m.id === messageId);
    if (!msg) return null;

    if (!msg.reactions || typeof msg.reactions !== 'object') {
      msg.reactions = {};
    }
    if (!Array.isArray(msg.reactions[emoji])) {
      msg.reactions[emoji] = [];
    }

    const usersList = msg.reactions[emoji];
    const idx = usersList.indexOf(userName);
    if (idx === -1) {
      usersList.push(userName);
    } else {
      usersList.splice(idx, 1);
      if (usersList.length === 0) {
        delete msg.reactions[emoji];
      }
    }

    this.saveToDisk();
    return {
      messageId: msg.id,
      reactions: msg.reactions,
    };
  }

  getMessages(room) {
    const key = this.normalizeKey(room);
    if (!key || !this.rooms.has(key)) return [];
    return [...this.rooms.get(key)];
  }

  clearRoom(room) {
    const key = this.normalizeKey(room);
    if (key) {
      this.rooms.delete(key);
      this.saveToDisk();
    }
  }
}

module.exports = { MessageStore };
