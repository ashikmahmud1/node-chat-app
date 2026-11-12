const { roomChannel } = require('../utils/message');
const { reject } = require('./events');

function validSdp(sdp, type) {
  if (sdp?.type !== type || typeof sdp.sdp !== 'string' || sdp.sdp.length > 80000 || !sdp.sdp.startsWith('v=0')) {
    return false;
  }
  const media = Array.from(sdp.sdp.matchAll(/^m=(\S+)/gm), (match) => match[1]);
  return media.length > 0 && media.length <= (type === 'offer' ? 3 : 64) &&
    media.every((kind) => kind === 'audio' || kind === 'video');
}

function validPublications(sdp, mode, screenMid) {
  if (typeof screenMid !== 'string' || !screenMid || screenMid.length > 32) return false;
  const media = sdp.split(/^m=/m).slice(1).map((section) => ({
    kind: section.split(' ', 1)[0],
    mid: /^a=mid:(\S+)\r?$/m.exec(section)?.[1],
    sends: /^a=sendonly\r?$/m.test(section),
  }));
  return media.length === (mode === 'video' ? 3 : 2) &&
    media.every(({ mid, sends }) => mid && sends) &&
    new Set(media.map(({ mid }) => mid)).size === media.length &&
    media.filter(({ kind }) => kind === 'audio').length === 1 &&
    media.some(({ kind, mid }) => kind === 'video' && mid === screenMid);
}

function registerSfuHandlers({ socket, users, sfuService, calls, on, signalingLimiter }) {
  on('sfu:join', ({ sessionId, mode, sdp, screenMid }) => {
    const user = users.getUser(socket.id);
    if (!user || typeof sessionId !== 'string' ||
        (!sessionId.startsWith('private:') && sessionId !== `room:${roomChannel(user.room)}`) ||
        !calls.authorize(socket.id, sessionId, mode)) reject('You cannot join this call.');
    if (!['audio', 'video'].includes(mode) || !validSdp(sdp, 'offer') ||
        !validPublications(sdp.sdp, mode, screenMid)) reject('Invalid call offer.');
    return sfuService.joinSession({ sessionId, socket, mode, sdp, screenMid, user });
  });

  on('sfu:ready', ({ sessionId }) => sfuService.ready(sessionId, socket.id), signalingLimiter);

  on('sfu:answer', ({ sessionId, revision, sdp }) => {
    if (!validSdp(sdp, 'answer') || !Number.isSafeInteger(revision)) reject('Invalid call answer.');
    return sfuService.handleAnswer({ sessionId, socketId: socket.id, revision, sdp });
  }, signalingLimiter);

  on('sfu:media-state', ({ sessionId, audioEnabled, videoEnabled, screenSharing }) => {
    const state = sfuService.updateMediaState({ sessionId, socketId: socket.id, audioEnabled, videoEnabled, screenSharing });
    if (!state) reject('The call media is no longer connected.');
    return state;
  }, signalingLimiter);

  on('sfu:leave', ({ sessionId }) => {
    if (typeof sessionId === 'string' && sessionId.startsWith('room:')) sfuService.closePeer(sessionId, socket.id);
  }, signalingLimiter);
}

module.exports = { registerSfuHandlers };
