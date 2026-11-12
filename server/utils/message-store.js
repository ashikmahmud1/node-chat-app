const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const { directConversation, messagePreview, roomChannel } = require('./message');

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
      PRAGMA foreign_keys = ON;
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
      CREATE INDEX IF NOT EXISTS messages_author ON messages (conversation, json_extract(payload, '$.authorId'), created_at);
      CREATE TABLE IF NOT EXISTS direct_threads (
        conversation TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        guest_a TEXT NOT NULL,
        guest_b TEXT NOT NULL,
        name_a TEXT,
        name_b TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS direct_threads_a ON direct_threads (room, guest_a);
      CREATE INDEX IF NOT EXISTS direct_threads_b ON direct_threads (room, guest_b);
      CREATE TABLE IF NOT EXISTS direct_reads (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        read_at INTEGER NOT NULL
      ) STRICT;
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
    this.migrateDirectThreads();
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

  migrateDirectThreads() {
    const key = 'direct_threads_v1';
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM settings WHERE name = ?').get(key)) return;
      const rows = this.db.prepare(`
        SELECT conversation, created_at, json_extract(payload, '$.authorId') AS author, json_extract(payload, '$.from') AS name
        FROM messages WHERE substr(conversation, 1, 6) = '["dm",' AND created_at >= ? ORDER BY sequence
      `).iterate(Date.now() - config.limits.retentionMs);
      const save = this.directThreadUpsert();
      for (const row of rows) {
        const [, room, first, second] = JSON.parse(row.conversation);
        if (row.author !== first && row.author !== second) continue;
        save.run(row.conversation, room, first, second, row.author === first ? row.name : null,
          row.author === second ? row.name : null, row.created_at);
      }
      this.db.prepare('INSERT INTO settings VALUES (?, ?)').run(key, '1');
    });
  }

  directThreadUpsert() {
    return this.db.prepare(`
      INSERT INTO direct_threads VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation) DO UPDATE SET
        name_a = COALESCE(excluded.name_a, name_a), name_b = COALESCE(excluded.name_b, name_b),
        updated_at = MAX(updated_at, excluded.updated_at)
    `);
  }

  addDirectMessage(sender, recipient, message, enqueue) {
    const key = directConversation(sender, recipient);
    return this.addMessage(key, { ...message, authorId: sender.guestId }, [sender, recipient], enqueue);
  }

  addMessage(conversation, message, participants, enqueue) {
    const saved = { reactions: {}, edited: false, ...message };
    return this.transaction(() => {
      this.db.prepare('INSERT INTO messages (id, conversation, created_at, payload) VALUES (?, ?, ?, ?)')
        .run(saved.id, conversation, saved.createdAt, JSON.stringify(saved));
      if (participants) {
        const [sender, recipient] = participants;
        const [first, second] = sender.guestId < recipient.guestId ? participants : [recipient, sender];
        this.directThreadUpsert().run(conversation, roomChannel(first.room), first.guestId, second.guestId,
          first.name, second.name, saved.createdAt);
        enqueue?.();
      } else {
        this.db.prepare(`
          DELETE FROM messages WHERE sequence IN (
            SELECT sequence FROM messages WHERE conversation = ? ORDER BY sequence DESC LIMIT -1 OFFSET ?
          )
        `).run(conversation, this.limit);
      }
      if (!saved.replyTo) return saved;
      const target = this.getMessage(conversation, saved.replyTo);
      return { ...saved, reply: target ? messagePreview(target) : null };
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
    if (!message || message.authorId !== authorId || message.type === 'call') return false;
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    return true;
  }

  toggleReaction(conversation, id, emoji, user) {
    const message = this.getMessage(conversation, id);
    if (!message || message.type === 'call') return null;
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
    const messages = this.db.prepare('SELECT payload FROM messages WHERE conversation = ? AND created_at >= ? ORDER BY sequence')
      .all(conversation, Date.now() - config.limits.retentionMs).map((row) => JSON.parse(row.payload));
    const byId = new Map(messages.map((message) => [message.id, message]));
    return messages.map((message) => {
      if (!message.replyTo) return message;
      const target = byId.get(message.replyTo);
      return { ...message, reply: target ? messagePreview(target) : null };
    });
  }

  getDirectPage(conversation, before = Number.MAX_SAFE_INTEGER) {
    const rows = this.db.prepare(`
      SELECT m.sequence, m.payload, r.read_at FROM messages m LEFT JOIN direct_reads r ON r.message_id = m.id
      WHERE m.conversation = ? AND m.created_at >= ? AND m.sequence < ?
      ORDER BY m.sequence DESC LIMIT ?
    `).all(conversation, Date.now() - config.limits.retentionMs, before, this.limit + 1);
    const page = rows.slice(0, this.limit).reverse();
    const messages = page.map((row) => {
      const message = JSON.parse(row.payload);
      if (row.read_at !== null) message.readAt = row.read_at;
      if (message.replyTo) {
        const target = this.getMessage(conversation, message.replyTo);
        message.reply = target ? messagePreview(target) : null;
      }
      return message;
    });
    return { messages, before: rows.length > this.limit ? page[0].sequence : null };
  }

  getDirectPeer(sender, guestId) {
    const thread = this.db.prepare('SELECT * FROM direct_threads WHERE conversation = ? AND updated_at >= ?')
      .get(directConversation(sender, { guestId }), Date.now() - config.limits.retentionMs);
    if (!thread) return null;
    return { guestId, room: sender.room, name: thread.guest_a === guestId ? thread.name_a : thread.name_b };
  }

  getNotificationMessage(id, guestId) {
    const target = this.db.prepare(`
      SELECT t.room, t.guest_a, t.name_a, t.name_b, json_extract(m.payload, '$.authorId') AS author,
        r.read_at AS readAt
      FROM messages m JOIN direct_threads t ON t.conversation = m.conversation
      LEFT JOIN direct_reads r ON r.message_id = m.id
      WHERE m.id = ? AND m.created_at >= ? AND (t.guest_a = ? OR t.guest_b = ?)
        AND json_extract(m.payload, '$.authorId') <> ?
    `).get(id, Date.now() - config.limits.retentionMs, guestId, guestId, guestId);
    if (!target) return null;
    return {
      room: target.room.slice('chat:'.length),
      name: target.guest_a === guestId ? target.name_a : target.name_b,
      peerId: target.author,
      readAt: target.readAt,
    };
  }

  rememberDirectName({ room, guestId, name }) {
    const channel = roomChannel(room);
    this.db.prepare('UPDATE direct_threads SET name_a = ? WHERE room = ? AND guest_a = ?').run(name, channel, guestId);
    this.db.prepare('UPDATE direct_threads SET name_b = ? WHERE room = ? AND guest_b = ?').run(name, channel, guestId);
  }

  getDirectThread(conversation, recipientId) {
    const cutoff = Date.now() - config.limits.retentionMs;
    const last = this.db.prepare(`
      SELECT payload FROM messages WHERE conversation = ? AND created_at >= ? ORDER BY sequence DESC LIMIT 1
    `).get(conversation, cutoff);
    const { count } = this.db.prepare(`
      SELECT COUNT(*) AS count FROM messages m
      WHERE m.conversation = ? AND m.created_at >= ? AND json_extract(m.payload, '$.authorId') = ?
        AND NOT EXISTS (SELECT 1 FROM direct_reads r WHERE r.message_id = m.id)
    `).get(conversation, cutoff, recipientId);
    const message = last && JSON.parse(last.payload);
    return {
      latest: message ? { ...messagePreview(message), authorId: message.authorId, createdAt: message.createdAt } : null,
      unread: count,
    };
  }

  getDirectThreads(user) {
    return this.db.prepare(`
      SELECT * FROM direct_threads WHERE room = ? AND (guest_a = ? OR guest_b = ?) AND updated_at >= ?
      ORDER BY updated_at DESC
    `).all(roomChannel(user.room), user.guestId, user.guestId, Date.now() - config.limits.retentionMs).map((thread) => {
      const first = thread.guest_a === user.guestId;
      const guestId = first ? thread.guest_b : thread.guest_a;
      const name = first ? thread.name_b : thread.name_a;
      return { peer: { guestId, name }, ...this.getDirectThread(thread.conversation, guestId) };
    });
  }

  markDirectRead(conversation, authorId, messageIds) {
    return this.transaction(() => {
      const now = Date.now();
      const mark = this.db.prepare(`
        INSERT INTO direct_reads (message_id, read_at)
        SELECT id, ? FROM messages WHERE conversation = ? AND id = ? AND created_at >= ?
          AND json_extract(payload, '$.authorId') = ?
        ON CONFLICT(message_id) DO NOTHING
      `);
      const read = this.db.prepare(`
        SELECT m.id, r.read_at AS readAt FROM messages m JOIN direct_reads r ON r.message_id = m.id
        WHERE m.conversation = ? AND m.id = ? AND m.created_at >= ? AND json_extract(m.payload, '$.authorId') = ?
      `);
      let changed = false;
      const receipts = [];
      for (const id of messageIds) {
        const scope = [conversation, id, now - config.limits.retentionMs, authorId];
        if (mark.run(now, ...scope).changes) changed = true;
        const receipt = read.get(...scope);
        if (receipt) receipts.push(receipt);
      }
      return { receipts, changed };
    });
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
    const cutoff = Date.now() - config.limits.retentionMs;
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
      this.db.prepare('DELETE FROM direct_threads WHERE updated_at < ?').run(cutoff);
    });
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
