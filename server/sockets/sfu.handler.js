const { roomChannel } = require('../utils/message');
const { reject } = require('./events');

function validSdp(sdp, type) {
  if (sdp?.type !== type || typeof sdp.sdp !== 'string' || sdp.sdp.length > 80000 || !sdp.sdp.startsWith('v=0')) {
    return false;
  }
  const media = Array.from(sdp.sdp.matchAll(/^m=(\S+)/gm), (match) => match[1]);
  return media.length > 0 && media.length <= (type === 'offer' ? 2 : 64) &&
    media.every((kind) => kind === 'audio' || kind === 'video') &&
    (type !== 'offer' || new Set(media).size === media.length);
}

function registerSfuHandlers({ socket, users, sfuService, calls, on, signalingLimiter }) {
  on('sfu:join', ({ sessionId, mode, sdp }) => {
    const user = users.getUser(socket.id);
    if (!user || typeof sessionId !== 'string' ||
        (!sessionId.startsWith('private:') && sessionId !== `room:${roomChannel(user.room)}`) ||
        !calls.authorize(socket.id, sessionId, mode)) reject('You cannot join this call.');
    if (!['audio', 'video'].includes(mode) || !validSdp(sdp, 'offer')) reject('Invalid call offer.');
    return sfuService.joinSession({ sessionId, socket, mode, sdp, user });
  });

  on('sfu:ready', ({ sessionId }) => sfuService.ready(sessionId, socket.id), signalingLimiter);

  on('sfu:answer', ({ sessionId, revision, sdp }) => {
    if (!validSdp(sdp, 'answer') || !Number.isSafeInteger(revision)) reject('Invalid call answer.');
    return sfuService.handleAnswer({ sessionId, socketId: socket.id, revision, sdp });
  }, signalingLimiter);

  on('sfu:media-state', ({ sessionId, audioEnabled, videoEnabled, screenSharing }) =>
    sfuService.updateMediaState({ sessionId, socketId: socket.id, audioEnabled, videoEnabled, screenSharing }), signalingLimiter);

  on('sfu:leave', ({ sessionId }) => {
    if (typeof sessionId === 'string' && sessionId.startsWith('room:')) sfuService.closePeer(sessionId, socket.id);
  }, signalingLimiter);
}

module.exports = { registerSfuHandlers };
