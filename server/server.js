const http = require('http');
const config = require('./config');
const { createApp } = require('./app');
const { initializeSocket } = require('./sockets');
const { Users } = require('./utils/users');
const { MessageStore } = require('./utils/message-store');
const { logger } = require('./utils/logger');

const sharedUsers = new Users();
const sharedMessageStore = new MessageStore();

const tempServer = http.createServer();
const { io, users, messageStore, sfuService } = initializeSocket(
  tempServer,
  {},
  sharedUsers,
  sharedMessageStore
);
const app = createApp(sharedUsers, sfuService);
tempServer.on('request', app);
const httpServer = tempServer;

const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}. Closing server gracefully...`);
  io.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
};

if (require.main === module) {
  httpServer.listen(config.port, () => {
    logger.info(`Server is up on port ${config.port}`, { port: config.port, env: config.env });
  });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { app, httpServer, io, users, messageStore, sfuService };
