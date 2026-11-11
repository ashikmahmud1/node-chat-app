const http = require('node:http');
const config = require('./config');
const { createApp } = require('./app');
const { initializeSocket } = require('./sockets');
const { Users } = require('./utils/users');
const { MessageStore } = require('./utils/message-store');
const { logger } = require('./utils/logger');
const { verifyBucket } = require('./middlewares/file-upload-s3');
const { createGuestSession } = require('./services/guest-session');
const { createFileHandlers } = require('./controllers/file.controller');

function createServer(messageStore = new MessageStore()) {
  const users = new Users();
  const guestSession = createGuestSession(messageStore.getSessionKey());
  const { io, sfuService } = initializeSocket(users, messageStore, guestSession);
  const files = createFileHandlers({ users, messageStore, guestSession, io });
  const app = createApp({ users, guestSession, files });
  const httpServer = http.createServer({ requestTimeout: 120000 }, app);
  io.attach(httpServer);

  let pendingPurge = Promise.resolve();
  const purge = () => {
    pendingPurge = pendingPurge.then(files.purge).catch((error) =>
      logger.error('Retention cleanup failed', { error: error.message })
    );
  };
  const cleanup = setInterval(purge, 15 * 60 * 1000);
  cleanup.unref();

  async function close() {
    clearInterval(cleanup);
    await io.close();
    await sfuService.closeAllSessions();
    await pendingPurge;
    messageStore.close();
  }

  return { app, httpServer, close, purge };
}

async function main() {
  if (config.env === 'production' && !config.publicOrigin.startsWith('https:')) {
    throw new Error('Production requires an HTTPS PUBLIC_ORIGIN.');
  }
  if (config.storageType === 's3') await verifyBucket();
  const { httpServer, close, purge } = createServer();
  purge();
  httpServer.on('error', (error) => {
    logger.error('HTTP server failed', { error: error.message });
    process.exit(1);
  });
  httpServer.listen(config.port, () => logger.info('Chat server listening', { port: config.port }));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    try {
      await close();
    } catch (error) {
      logger.error('Shutdown failed', { error: error.message });
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Startup failed', { error: error.message });
    process.exitCode = 1;
  });
}

module.exports = { createServer };
