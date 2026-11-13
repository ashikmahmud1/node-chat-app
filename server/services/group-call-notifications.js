const { roomChannel } = require('../utils/message');
const { logger } = require('../utils/logger');
const { GROUP_CALL_KINDS } = require('./push');

class GroupCallNotifications {
  constructor(io, users, sfu, push) {
    this.io = io;
    this.users = users;
    this.sfu = sfu;
    this.push = push;
    this.active = new Map();
  }

  start(call) {
    const alert = { ...call, channel: roomChannel(call.room), notified: new Set(), silenced: new Set() };
    this.active.set(call.id, alert);
    try {
      for (const { guestId } of this.push.groupSubscribers(alert.channel)) this.notify(alert, guestId);
    } catch (error) {
      logger.error('Could not queue group call notifications', { error: error.name });
    }
    this.push.wake();
  }

  end(id) {
    this.active.delete(id);
    try {
      this.push.cancelCall(id);
    } catch (error) {
      logger.error('Could not cancel group call notifications', { error: error.name });
    }
  }

  canDeliver(id, guestId) {
    const alert = this.active.get(id);
    return Boolean(alert && alert.caller.guestId !== guestId && !alert.silenced.has(guestId) && alert.expiresAt > Date.now() &&
      this.push.groupMember(guestId, alert.channel));
  }

  notify(alert, guestId) {
    if (alert.notified.has(guestId) || !this.canDeliver(alert.id, guestId) || this.push.status(guestId) === 'dnd' ||
        this.push.foreground(this.io, this.users, guestId, alert.room) ||
        this.users.getUserList(alert.room).some((user) => user.guestId === guestId && this.sfu.hasPeer(user.id))) return;
    if (this.push.enqueue(guestId, GROUP_CALL_KINDS[alert.mode], alert.id, alert.expiresAt)) {
      alert.notified.add(guestId);
      return true;
    }
  }

  notifyBackground(user) {
    const call = this.sfu.getRoomCall('room:' + roomChannel(user.room));
    const alert = this.active.get(call?.id);
    if (!alert) return;
    try {
      if (this.notify(alert, user.guestId)) this.push.wake();
    } catch (error) {
      logger.error('Could not queue group call notification', { error: error.name });
    }
  }

  silence(user, id) {
    const alert = this.active.get(id);
    if (alert?.channel === roomChannel(user.room) && alert.expiresAt > Date.now()) {
      alert.silenced.add(user.guestId);
    }
  }

  target(id, guestId) {
    const alert = this.active.get(id);
    if (!alert?.notified.has(guestId)) return null;
    const member = this.push.groupMember(guestId, alert.channel);
    return member && { room: alert.room, name: member.name, groupCallId: id };
  }
}

module.exports = { GroupCallNotifications };
