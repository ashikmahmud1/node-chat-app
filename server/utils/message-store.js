const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

class MessageStore {
  constructor(limit = config.limits.maxRoomHistory, databasePath = config.paths.database) {
    this.limit = limit;
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(databasePath, 'a', 0o600));
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        conversation TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation, sequence DESC);
      CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        room TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS attachments_created ON attachments (created_at);
    `);
  }

  getSessionKey() {
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('session_key', ?)").run(randomBytes(32).toString('hex'));
    return Buffer.from(this.db.prepare("SELECT value FROM settings WHERE name = 'session_key'").get().value, 'hex');
  }

  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addMessage(conversation, message) {
    const saved = { reactions: {}, edited: false, ...message };
    return this.transaction(() => {
      this.db.prepare('INSERT INTO messages (id, conversation, created_at, payload) VALUES (?, ?, ?, ?)')
        .run(saved.id, conversation, saved.createdAt, JSON.stringify(saved));
      this.db.prepare(`
        DELETE FROM messages WHERE sequence IN (
          SELECT sequence FROM messages WHERE conversation = ? ORDER BY sequence DESC LIMIT -1 OFFSET ?
        )
      `).run(conversation, this.limit);
      return saved;
    });
  }

  getMessage(conversation, id) {
    const row = this.db.prepare('SELECT payload FROM messages WHERE conversation = ? AND id = ? AND created_at >= ?').get(conversation, id, Date.now() - config.limits.retentionMs);
    return row ? JSON.parse(row.payload) : null;
  }

  editMessage(conversation, id, authorId, text) {
    const message = this.getMessage(conversation, id);
    if (!message || message.authorId !== authorId || message.type !== 'text') return null;
    const updated = { ...message, text, edited: true, editedAt: Date.now() };
    this.updateMessage(updated);
    return updated;
  }

  deleteMessage(conversation, id, authorId) {
    const message = this.getMessage(conversation, id);
    if (!message || message.authorId !== authorId) return false;
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    return true;
  }

  toggleReaction(conversation, id, emoji, user) {
    const message = this.getMessage(conversation, id);
    if (!message) return null;
    const reactions = message.reactions[emoji] || [];
    const existing = reactions.some((reaction) => reaction.authorId === user.guestId);
    if (!existing && reactions.length >= config.limits.maxRoomUsers) return null;
    const next = existing
      ? reactions.filter((reaction) => reaction.authorId !== user.guestId)
      : [...reactions, { authorId: user.guestId, name: user.name }];
    if (next.length) message.reactions[emoji] = next;
    else delete message.reactions[emoji];
    this.updateMessage(message);
    return { messageId: id, reactions: message.reactions };
  }

  updateMessage(message) {
    this.db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(JSON.stringify(message), message.id);
  }

  getMessages(conversation) {
    return this.db.prepare('SELECT payload FROM messages WHERE conversation = ? AND created_at >= ? ORDER BY sequence')
      .all(conversation, Date.now() - config.limits.retentionMs).map((row) => JSON.parse(row.payload));
  }

  reserveAttachment({ id, name, room, sender, recipient }) {
    this.db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?)').run(id, name, room, sender, recipient, Date.now());
  }

  setAttachmentName(id, name) {
    this.db.prepare('UPDATE attachments SET name = ? WHERE id = ?').run(name, id);
  }

  getAttachment(id) {
    return this.db.prepare(`
      SELECT attachments.* FROM attachments JOIN messages USING (id)
      WHERE id = ? AND messages.created_at >= ?
    `).get(id, Date.now() - config.limits.retentionMs);
  }

  purgeExpiredMessages() {
    this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(Date.now() - config.limits.retentionMs);
  }

  getOrphanAttachments() {
    return this.db.prepare(`
      SELECT attachments.id FROM attachments LEFT JOIN messages USING (id)
      WHERE messages.id IS NULL AND attachments.created_at < ? LIMIT 200
    `).all(Date.now() - 3600000);
  }

  forgetAttachment(id) {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  }

  close() {
    this.db.close();
  }
}

module.exports = { MessageStore };
