const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOAD_DIR = path.join(ROOT_DIR, 'data');

const buildIceServers = () => {
  const servers = [
    { urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' },
  ];

  if (process.env.TURN_URL) {
    const turnServer = { urls: process.env.TURN_URL };
    if (process.env.TURN_USERNAME) turnServer.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turnServer.credential = process.env.TURN_CREDENTIAL;
    servers.push(turnServer);
  }

  return servers;
};

module.exports = {
  port: Number(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',
  storageType: process.env.STORAGE_TYPE || 'local', // 'local' or 's3'
  limits: {
    maxNameLength: 50,
    maxRoomLength: 50,
    maxMessageLength: 2000,
    maxFileSize: 50 * 1024 * 1024, // 50 MB
    maxRoomHistory: Number(process.env.MAX_ROOM_HISTORY) || 50,
    httpRateLimitWindowMs: 60 * 1000, // 1 minute
    httpRateLimitMax: Number(process.env.HTTP_RATE_LIMIT_MAX) || 120,
    socketRateLimitWindowMs: 10 * 1000, // 10 seconds
    socketRateLimitMax: Number(process.env.SOCKET_RATE_LIMIT_MAX) || 40,
  },
  paths: {
    root: ROOT_DIR,
    public: PUBLIC_DIR,
    uploads: UPLOAD_DIR,
  },
  webrtc: {
    iceServers: buildIceServers(),
  },
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT || process.env.S3_ENDPOINT || '',
    forcePathStyle:
      process.env.AWS_FORCE_PATH_STYLE === 'true' ||
      Boolean(process.env.AWS_ENDPOINT || process.env.S3_ENDPOINT),
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    bucketName: process.env.AWS_S3_BUCKET_NAME || 'chat-app-uploads',
  },
};
