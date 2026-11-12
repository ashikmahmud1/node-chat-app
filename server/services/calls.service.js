const { randomUUID } = require('node:crypto');
const { findDirectPeer, saveDirectMessage } = require('./direct-messages');
const { logger } = require('../utils/logger');
const { roomChannel } = require('../utils/message');
const { reject } = require('../sockets/events');

class CallsService {
  constructor(io, users, sfu, messageStore, push) {
    this.io = io;
    this.users = users;
    this.sfu = sfu;
    this.messageStore = messageStore;
    this.push = push;
    this.bySocket = new Map();
    this.byGuest = new Map();
    this.byId = new Map();
  }

  start(socketId, peerId, mode) {
    const caller = this.users.getUser(socketId);
    const recipient = findDirectPeer(this.users, this.messageStore, caller, peerId);
    if (!recipient) reject('This person is no longer in your group.');
    if (!['audio', 'video'].includes(mode)) reject('Invalid call mode.');
    if (recipient.status === 'dnd' || this.push.status(recipient.guestId) === 'dnd' ||
        [caller.guestId, recipient.guestId].some((id) => this.byGuest.has(id)) ||
        [socketId, recipient.id].some((id) => id && this.sfu.hasPeer(id))) {
      reject('One of the participants is unavailable.');
    }
    const ringTime = 45000;
    const call = { id: randomUUID(), caller, recipient, mode, acceptedAt: null, expiresAt: Date.now() + ringTime };
    if (!this.push.foreground(this.io, this.users, recipient.guestId, caller.room)) {
      call.notified = Boolean(this.push.enqueue(recipient.guestId, 'call', call.id, call.expiresAt));
    }
    if (!recipient.id && !call.notified) reject('This person is offline and has not enabled call notifications.');
    call.timer = setTimeout(() => this.finish(socketId, call.id, 'no_answer'), ringTime);
    call.timer.unref();
    this.bySocket.set(socketId, call);
    this.byGuest.set(caller.guestId, call);
    this.byGuest.set(recipient.guestId, call);
    this.byId.set(call.id, call);
    if (recipient.id) this.offer(call);
    if (call.notified) this.push.wake();
    return { id: call.id };
  }

  offer(call) {
    this.bySocket.set(call.recipient.id, call);
    this.io.to(call.recipient.id).emit('call:incoming', { id: call.id, caller: call.caller, mode: call.mode });
  }

  notify(call) {
    if (call.notified || call.acceptedAt || Date.now() >= call.expiresAt) return;
    try {
      if (this.push.status(call.recipient.guestId) === 'dnd') return;
      call.notified = Boolean(this.push.enqueue(call.recipient.guestId, 'call', call.id, call.expiresAt));
      if (call.notified) this.push.wake();
    } catch (error) {
      logger.error('Could not queue incoming call notification', { error: error.name });
    }
  }

  attach(user) {
    const call = this.byGuest.get(user.guestId);
    if (!call || call.recipient.guestId !== user.guestId || call.recipient.id || call.acceptedAt ||
        Date.now() >= call.expiresAt || roomChannel(call.caller.room) !== roomChannel(user.room)) return;
    if (user.status === 'dnd' || this.sfu.hasPeer(user.id)) return;
    call.recipient = user;
    this.offer(call);
  }

  notifyBackground(user) {
    const call = this.bySocket.get(user.id);
    if (call?.recipient.id === user.id && !this.push.foreground(this.io, this.users, user.guestId, user.room)) this.notify(call);
  }

  notificationTarget(id, guestId) {
    const call = this.byId.get(id);
    if (!call || call.recipient.guestId !== guestId || (!call.acceptedAt && Date.now() >= call.expiresAt)) return null;
    return { room: call.caller.room, name: call.recipient.name, peerId: call.caller.guestId };
  }

  leave(socketId) {
    const call = this.bySocket.get(socketId);
    if (!call) return;
    if (call.recipient.id === socketId && !call.acceptedAt && Date.now() < call.expiresAt &&
        this.push.hasSubscription(call.recipient.guestId)) {
      this.bySocket.delete(socketId);
      call.recipient = { ...call.recipient, id: null };
      this.notify(call);
      return;
    }
    this.finish(socketId, call.id, 'left');
  }

  accept(socketId, id) {
    const call = this.bySocket.get(socketId);
    if (!call || call.id !== id || call.recipient.id !== socketId || call.acceptedAt || Date.now() >= call.expiresAt) {
      reject('This call is no longer ringing.');
    }
    clearTimeout(call.timer);
    this.push.cancelCall(id);
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
    this.byId.delete(call.id);
    this.byGuest.delete(call.caller.guestId);
    this.byGuest.delete(call.recipient.guestId);
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
      if (!user.id) continue;
      this.io.to(user.id).emit('call:ended', result);
      this.sfu.closePeer(`private:${call.id}`, user.id);
    }
    try {
      this.push.cancelCall(call.id);
      saveDirectMessage(this, call.caller, call.recipient, {
        ...result,
        wasAnswered: Boolean(call.acceptedAt),
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
