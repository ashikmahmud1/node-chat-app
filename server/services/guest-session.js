const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const config = require('../config');

const COOKIE_NAME = 'nexus_guest';
const MAX_AGE = 30 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hasAllowedOrigin(req) {
  const { origin, host } = req.headers;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  if (config.publicOrigin) return origin === config.publicOrigin;
  return origin === `http://${host}`;
}

function createGuestSession(key) {
  const sign = (value) => createHmac('sha256', key).update(value).digest('hex');

  function readSession(req) {
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (!cookie) return null;
    const [id, expires, signature, ...rest] = cookie.slice(COOKIE_NAME.length + 1).split('.');
    if (rest.length || !UUID.test(id) || !/^\d{10}$/.test(expires) ||
        Number(expires) <= Math.floor(Date.now() / 1000) || !/^[0-9a-f]{64}$/.test(signature)) return null;
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(`${id}.${expires}`), 'hex'))
      ? { guestId: id, expiresAt: Number(expires) * 1000 } : null;
  }

  const read = (req) => readSession(req)?.guestId || null;

  function establish(req, res) {
    if (!hasAllowedOrigin(req)) return res.status(403).json({ error: 'Origin is not allowed.' });
    const guestId = read(req) || randomUUID();
    const value = `${guestId}.${Math.floor(Date.now() / 1000) + MAX_AGE}`;
    res.cookie(COOKIE_NAME, `${value}.${sign(value)}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.publicOrigin.startsWith('https:'),
      path: '/',
      maxAge: MAX_AGE * 1000,
    });
    return res.set('Cache-Control', 'no-store').json({ guestId });
  }

  return { read, readSession, establish };
}

module.exports = { createGuestSession, hasAllowedOrigin, UUID };
