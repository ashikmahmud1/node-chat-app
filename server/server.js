const http = require('http');
const config = require('./config');
const { createApp } = require('./app');
const { initializeSocket } = require('./sockets');
const { Users } = require('./utils/users');
const { MessageStore } = require('./utils/message-store');
const { logger } = require('./utils/logger');
const { ensureBucketExists } = require('./middlewares/file-upload-s3');

const sharedUsers = new Users();
const sharedMessageStore = new MessageStore();

let activeSfuService = null;
const app = createApp(sharedUsers, {
  getActiveSessionCount: () => (activeSfuService ? activeSfuService.getActiveSessionCount() : 0),
});
const httpServer = http.createServer(app);
const { io, users, messageStore, sfuService } = initializeSocket(
  httpServer,
  {},
  sharedUsers,
  sharedMessageStore
);
activeSfuService = sfuService;

const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}. Closing server gracefully...`);
  const forceExitTimer = setTimeout(() => {
    logger.warn('Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
  if (typeof forceExitTimer.unref === 'function') {
    forceExitTimer.unref();
  }

  try {
    if (sharedMessageStore && typeof sharedMessageStore.flushToDisk === 'function') {
      await sharedMessageStore.flushToDisk();
    }
    if (activeSfuService && typeof activeSfuService.closeAllSessions === 'function') {
      await activeSfuService.closeAllSessions();
    }
  } catch (err) {
    logger.warn('Error during shutdown cleanup', { error: err.message });
  }

  io.close(() => {
    httpServer.close(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  });
};

if (require.main === module) {
  if (config.storageType === 's3') {
    ensureBucketExists(config.aws.bucketName).catch((err) => {
      logger.warn('Failed to verify or create S3 bucket on startup', { error: err.message });
    });
  }

  httpServer.listen(config.port, () => {
    logger.info(`Server is up on port ${config.port}`, {
      port: config.port,
      env: config.env,
      storageType: config.storageType,
    });
  });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection', {
      error: reason && reason.message ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
    gracefulShutdown('uncaughtException');
  });
}

module.exports = { app, httpServer, io, users, messageStore, sfuService };
