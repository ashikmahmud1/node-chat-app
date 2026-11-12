const { ECDH } = require('node:crypto');
const webPush = require('web-push');
const config = require('../config');
const { logger } = require('../utils/logger');

const MESSAGE_TTL = 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTIONS = 8;

function validEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.pathname === '/') return false;
  // Restrict outbound requests to the supported browser push services.
  return ['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname) ||
    url.hostname.endsWith('.push.apple.com') || url.hostname.endsWith('.notify.windows.com');
}

function validSubscription(value) {
  if (!validEndpoint(value?.endpoint)) return false;
  const { p256dh, auth } = value.keys || {};
  if (typeof p256dh !== 'string' || !/^[\w-]{87}$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[\w-]{22}$/.test(auth)) return false;
  try {
    const key = Buffer.from(p256dh, 'base64url');
    return key[0] === 4 && ECDH.convertKey(key, 'prime256v1').length === 65;
  } catch {
    return false;
  }
}

class PushService {
  constructor(messageStore, send = webPush.sendNotification) {
    this.messageStore = messageStore;
    this.db = messageStore.db;
    this.send = send;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        guest_id TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS push_subscriptions_guest ON push_subscriptions (guest_id, expires_at);
      CREATE TABLE IF NOT EXISTS push_jobs (
        endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (endpoint, kind, target_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS push_jobs_ready ON push_jobs (available_at);
      CREATE TABLE IF NOT EXISTS push_presence (
        guest_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      DELETE FROM push_jobs WHERE kind = 'call';
    `);
    this.vapid = messageStore.transaction(() => {
      const key = 'push_vapid_keys';
      const saved = this.db.prepare('SELECT value FROM settings WHERE name = ?').get(key);
      if (saved) return JSON.parse(saved.value);
      const keys = webPush.generateVAPIDKeys();
      this.db.prepare('INSERT INTO settings VALUES (?, ?)').run(key, JSON.stringify(keys));
      return keys;
    });
    const subject = process.env.PUSH_CONTACT || (config.publicOrigin.startsWith('https:') ? config.publicOrigin : 'https://127.0.0.1');
    if (!URL.canParse(subject) || !['https:', 'mailto:'].includes(new URL(subject).protocol)) {
      throw new Error('PUSH_CONTACT must be an HTTPS or mailto URL.');
    }
    this.vapid.subject = subject;
    this.running = null;
    this.stopped = false;
    this.interval = setInterval(() => this.wake(), 2000);
    this.interval.unref();
  }

  subscribe(guestId, expiresAt, subscription) {
    return this.messageStore.transaction(() => {
      const { endpoint, keys: { p256dh, auth } } = subscription;
      const previous = this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
      const now = Date.now();
      const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE guest_id = ? AND expires_at > ?')
        .get(guestId, now);
      if ((previous?.guest_id !== guestId || previous.expires_at <= now) && count >= MAX_SUBSCRIPTIONS) return false;
      if (previous && previous.guest_id !== guestId) {
        if (previous.auth !== auth || previous.p256dh !== p256dh) return false;
        this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
      }
      this.db.prepare(`
        INSERT INTO push_subscriptions VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, expires_at = excluded.expires_at
      `).run(endpoint, guestId, p256dh, auth, expiresAt);
      return true;
    });
  }

  refresh(guestId, endpoint, expiresAt) {
    return Boolean(this.db.prepare('UPDATE push_subscriptions SET expires_at = ? WHERE guest_id = ? AND endpoint = ? AND expires_at > ?')
      .run(expiresAt, guestId, endpoint, Date.now()).changes);
  }

  unsubscribe(guestId, endpoint) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE guest_id = ? AND endpoint = ?').run(guestId, endpoint);
  }

  hasSubscription(guestId) {
    return Boolean(this.db.prepare('SELECT 1 FROM push_subscriptions WHERE guest_id = ? AND expires_at > ? LIMIT 1')
      .get(guestId, Date.now()));
  }

  rememberPresence(user) {
    this.db.prepare(`
      INSERT INTO push_presence VALUES (?, ?, ?) ON CONFLICT(guest_id)
      DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    `).run(user.guestId, user.status, Date.now());
  }

  status(guestId) {
    return this.db.prepare('SELECT status FROM push_presence WHERE guest_id = ? AND updated_at >= ?')
      .get(guestId, Date.now() - config.limits.retentionMs)?.status || 'online';
  }

  foreground(io, users, guestId, room) {
    return users.getUserList(room).some((user) => user.guestId === guestId &&
      io.sockets.sockets.get(user.id)?.data.foreground === true);
  }

  enqueue(guestId, kind, id, expiresAt = Date.now() + MESSAGE_TTL) {
    const now = Date.now();
    return this.db.prepare(`
      INSERT OR IGNORE INTO push_jobs (endpoint, kind, target_id, expires_at, available_at)
      SELECT endpoint, ?, ?, ?, ? FROM push_subscriptions WHERE guest_id = ? AND expires_at > ?
    `).run(kind, id, expiresAt, now, guestId, now).changes;
  }

  cancelCall(id) {
    this.db.prepare("DELETE FROM push_jobs WHERE kind = 'call' AND target_id = ?").run(id);
  }

  wake() {
    if (this.stopped || this.running) return;
    this.running = this.deliver().catch((error) =>
      logger.error('Web Push queue failed', { error: error.name })
    ).finally(() => { this.running = null; });
  }

  purge() {
    const now = Date.now();
    this.db.prepare('DELETE FROM push_jobs WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM push_subscriptions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM push_presence WHERE updated_at < ?').run(now - config.limits.retentionMs);
  }

  async deliver() {
    const now = Date.now();
    const jobs = this.db.prepare(`
      SELECT j.*, s.guest_id, s.p256dh, s.auth FROM push_jobs j JOIN push_subscriptions s USING (endpoint)
      WHERE j.available_at <= ? AND j.expires_at > ? AND s.expires_at > ?
      ORDER BY (j.kind = 'call') DESC, j.available_at LIMIT 16
    `).all(now, now, now);
    const results = await Promise.allSettled(jobs.map((job) => this.deliverOne(job)));
    for (const result of results) {
      if (result.status === 'rejected') logger.error('Web Push job failed', { error: result.reason.name });
    }
  }

  async deliverOne(job) {
    const key = [job.endpoint, job.kind, job.target_id];
    const remove = () => this.db.prepare('DELETE FROM push_jobs WHERE endpoint = ? AND kind = ? AND target_id = ?').run(...key);
    if (this.status(job.guest_id) === 'dnd') return remove();
    if (job.kind === 'message') {
      const target = this.messageStore.getNotificationMessage(job.target_id, job.guest_id);
      if (!target || target.readAt) return remove();
    }
    const remaining = job.expires_at - Date.now();
    if (remaining <= 0) return remove();
    try {
      await this.send({ endpoint: job.endpoint, keys: { auth: job.auth, p256dh: job.p256dh } },
        JSON.stringify({ kind: job.kind, id: job.target_id, expiresAt: job.expires_at }), {
          vapidDetails: this.vapid,
          TTL: Math.floor(remaining / 1000),
          urgency: job.kind === 'call' ? 'high' : 'normal',
          topic: job.target_id.replaceAll('-', ''),
          timeout: 4000,
        });
      remove();
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        this.db.prepare('DELETE FROM push_subscriptions WHERE guest_id = ? AND endpoint = ? AND auth = ?')
          .run(job.guest_id, job.endpoint, job.auth);
      } else if (!error.statusCode || error.statusCode === 429 || error.statusCode >= 500) {
        const delay = Math.min(15 * 60, 2 ** Math.min(job.attempts + 1, 10)) * 1000;
        this.db.prepare(`
          UPDATE push_jobs SET attempts = attempts + 1, available_at = ? WHERE endpoint = ? AND kind = ? AND target_id = ?
        `).run(Date.now() + delay, ...key);
      } else {
        logger.warn('Web Push was rejected', { status: error.statusCode });
        remove();
      }
    }
  }

  async close() {
    this.stopped = true;
    clearInterval(this.interval);
    await this.running;
  }
}

module.exports = { PushService, validEndpoint, validSubscription };
