const { logger } = require('../utils/logger');

function createEventRegistrar(socket, limiter) {
  return (name, handle, rateLimiter = limiter) => {
    socket.on(name, async (payload, callback) => {
      const respond = typeof callback === 'function' ? callback : () => {};
      try {
        if (!rateLimiter.consume(socket.id).allowed) {
          return respond('Too many requests. Please try again shortly.');
        }
        const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        return respond(null, await handle(data));
      } catch (error) {
        if (!error.publicMessage) logger.error('Socket event failed', { event: name, error: error.message });
        return respond(error.publicMessage || 'The request could not be completed.');
      }
    });
  };
}

function reject(message) {
  const error = new Error(message);
  error.publicMessage = message;
  throw error;
}

module.exports = { createEventRegistrar, reject };
