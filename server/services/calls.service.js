const { randomUUID } = require('node:crypto');
const { saveDirectMessage } = require('./direct-messages');
const { logger } = require('../utils/logger');
const { sameRoomPeer } = require('../utils/message');
const { reject } = require('../sockets/events');

class CallsService {
  constructor(io, users, sfu, messageStore) {
    this.io = io;
    this.users = users;
    this.sfu = sfu;
    this.messageStore = messageStore;
    this.bySocket = new Map();
  }

  start(socketId, peerId, mode) {
    const caller = this.users.getUser(socketId);
    const recipient = sameRoomPeer(this.users, caller, peerId);
    if (!recipient) reject('This person is no longer in your group.');
    if (!['audio', 'video'].includes(mode)) reject('Invalid call mode.');
    if (recipient.status === 'dnd' || [socketId, peerId].some((id) => this.bySocket.has(id) || this.sfu.hasPeer(id))) {
      reject('One of the participants is unavailable.');
    }

    const call = { id: randomUUID(), caller, recipient, mode, acceptedAt: null };
    call.timer = setTimeout(() => this.finish(socketId, call.id, 'no_answer'), 25000);
    call.timer.unref();
    this.bySocket.set(socketId, call);
    this.bySocket.set(peerId, call);
    this.io.to(peerId).emit('call:incoming', { id: call.id, caller, mode });
    return { id: call.id };
  }

  accept(socketId, id) {
    const call = this.bySocket.get(socketId);
    if (!call || call.id !== id || call.recipient.id !== socketId || call.acceptedAt) reject('This call is no longer ringing.');
    clearTimeout(call.timer);
    call.acceptedAt = Date.now();
    call.timer = setTimeout(() => this.finish(socketId, id, 'failed'), 45000);
    call.timer.unref();
    this.io.to(call.caller.id).emit('call:accepted', { id });
  }

  mediaReady(socketId) {
    const call = this.bySocket.get(socketId);
    if (!call?.acceptedAt || call.connectedAt) return;
    const sessionId = `private:${call.id}`;
    if (this.sfu.getSessionParticipants(sessionId).filter((peer) => peer.connected).length !== 2) return;
    clearTimeout(call.timer);
    call.connectedAt = Date.now();
    this.io.to([call.caller.id, call.recipient.id]).emit('call:connected', { id: call.id });
  }

  authorize(socketId, sessionId, mode) {
    const call = this.bySocket.get(socketId);
    if (sessionId.startsWith('private:')) {
      return call?.acceptedAt && sessionId === `private:${call.id}` && mode === call.mode;
    }
    return !call;
  }

  finish(socketId, id, reason) {
    const call = this.bySocket.get(socketId);
    if (!call || (id && call.id !== id)) return;
    clearTimeout(call.timer);
    this.bySocket.delete(call.caller.id);
    this.bySocket.delete(call.recipient.id);
    const endedReason = reason === 'declined' && (call.acceptedAt || call.recipient.id !== socketId) ? undefined : reason;
    const result = {
      id: call.id,
      reason: endedReason || (call.connectedAt ? 'completed' : 'cancelled'),
      wasConnected: Boolean(call.connectedAt),
      durationSec: call.connectedAt ? Math.floor((Date.now() - call.connectedAt) / 1000) : 0,
    };
    for (const user of [call.caller, call.recipient]) {
      this.io.to(user.id).emit('call:ended', result);
      this.sfu.closePeer(`private:${call.id}`, user.id);
    }
    try {
      saveDirectMessage(this, call.caller, call.recipient, {
        ...result,
        from: call.caller.name,
        type: 'call',
        mode: call.mode,
        createdAt: Date.now(),
      });
    } catch (error) {
      logger.error('Could not save call record', { error: error.message });
    }
  }
}

module.exports = { CallsService };
