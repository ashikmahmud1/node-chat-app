const http = require('http');
const config = require('./config');
const { createApp } = require('./app');
const { initializeSocket } = require('./sockets');

const app = createApp();
const httpServer = http.createServer(app);
const { io, users } = initializeSocket(httpServer);

if (require.main === module) {
  httpServer.listen(config.port, () => {
    console.log(`Server is up on port ${config.port}`);
  });
}

module.exports = { app, httpServer, io, users };
