const express = require('express');
const { hasAllowedOrigin, UUID } = require('../services/guest-session');
const { validEndpoint, validSubscription } = require('../services/push');
const { roomChannel } = require('../utils/message');
const { isRealString } = require('../utils/validation');
const { limits } = require('../config');

function createPushRouter({ guestSession, messageStore, push, calls, groupNotifications }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!hasAllowedOrigin(req)) return res.status(403).json({ error: 'Origin is not allowed.' });
    req.pushSession = guestSession.readSession(req);
    if (!req.pushSession) return res.status(401).json({ error: 'This browser session has expired.' });
    next();
  });
  router.get('/', (req, res) => res.json({ publicKey: push.vapid.publicKey }));
  router.get('/target/:id', (req, res) => {
    const { guestId } = req.pushSession;
    const { id } = req.params;
    const group = UUID.test(id) && groupNotifications.target(id, guestId);
    if (group) return res.json(group);
    const target = UUID.test(id) && (calls.notificationTarget(id, guestId) || messageStore.getNotificationMessage(id, guestId));
    if (!target?.name) return res.status(404).json({ error: 'This notification is no longer available.' });
    return res.json({ room: target.room, name: target.name, peerId: target.peerId });
  });
  router.use(express.json({ limit: '6kb' }));
  router.delete('/group', (req, res) => {
    if (!isRealString(req.body?.room, limits.maxRoomLength)) return res.status(400).json({ error: 'Invalid group.' });
    push.leaveGroup(req.pushSession.guestId, roomChannel(req.body.room));
    return res.sendStatus(204);
  });
  router.put('/subscription', (req, res) => {
    if (!validSubscription(req.body)) return res.status(400).json({ error: 'Invalid push subscription.' });
    const { guestId, expiresAt } = req.pushSession;
    if (!push.subscribe(guestId, expiresAt, req.body)) {
      return res.status(409).json({ error: 'Could not register this browser for notifications.' });
    }
    return res.sendStatus(204);
  });
  router.patch('/subscription', (req, res) => {
    if (!validEndpoint(req.body?.endpoint)) return res.status(400).json({ error: 'Invalid push subscription.' });
    const { guestId, expiresAt } = req.pushSession;
    return res.json({ enabled: push.refresh(guestId, req.body.endpoint, expiresAt) });
  });
  router.delete('/subscription', (req, res) => {
    if (!validEndpoint(req.body?.endpoint)) return res.status(400).json({ error: 'Invalid push subscription.' });
    push.unsubscribe(req.pushSession.guestId, req.body.endpoint);
    return res.sendStatus(204);
  });
  return router;
}

module.exports = { createPushRouter };
