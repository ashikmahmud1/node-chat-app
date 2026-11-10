const config = require('../config');

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel =
  process.env.NODE_ENV === 'test'
    ? -1
    : LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

const formatLog = (level, message, meta = {}) => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
  return JSON.stringify(payload);
};

const logger = {
  error(message, meta) {
    if (currentLevel >= LEVELS.error) {
      console.error(formatLog('error', message, meta));
    }
  },
  warn(message, meta) {
    if (currentLevel >= LEVELS.warn) {
      console.warn(formatLog('warn', message, meta));
    }
  },
  info(message, meta) {
    if (currentLevel >= LEVELS.info) {
      console.log(formatLog('info', message, meta));
    }
  },
  debug(message, meta) {
    if (currentLevel >= LEVELS.debug || config.env === 'development') {
      if (currentLevel >= 0) {
        console.log(formatLog('debug', message, meta));
      }
    }
  },
};

module.exports = { logger };
