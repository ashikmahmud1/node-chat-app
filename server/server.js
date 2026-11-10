const http = require('http');
const config = require('./config');
const { createApp } = require('./app');
const { initializeSocket } = require('./sockets');
const { Users } = require('./utils/users');

const sharedUsers = new Users();
const app = createApp(sharedUsers);
const httpServer = http.createServer(app);
const { io, users } = initializeSocket(httpServer, {}, sharedUsers);

const gracefulShutdown = (signal) => {
  console.log(`Received ${signal}. Closing server gracefully...`);
  io.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
};

if (require.main === module) {
  httpServer.listen(config.port, () => {
    console.log(`Server is up on port ${config.port}`);
  });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { app, httpServer, io, users };
