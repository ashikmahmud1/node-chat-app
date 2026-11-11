const { reject } = require('./events');

function registerCallHandlers({ socket, calls, on, signalingLimiter }) {
  on('call:start', ({ peerId, mode }) => calls.start(socket.id, peerId, mode));
  on('call:accept', ({ id }) => calls.accept(socket.id, id), signalingLimiter);
  on('call:end', ({ id, reason }) => {
    if (typeof id !== 'string') reject('Invalid call.');
    calls.finish(socket.id, id, ['declined', 'failed'].includes(reason) ? reason : undefined);
  }, signalingLimiter);
}

module.exports = { registerCallHandlers };
