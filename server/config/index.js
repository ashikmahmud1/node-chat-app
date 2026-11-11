const { createHmac } = require('node:crypto');
const { isIPv4 } = require('node:net');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const publicOrigin = process.env.PUBLIC_ORIGIN || '';
if (publicOrigin && (!/^https?:/.test(publicOrigin) || new URL(publicOrigin).origin !== publicOrigin)) {
  throw new Error('PUBLIC_ORIGIN must be an HTTP or HTTPS origin without a path.');
}
const storageType = process.env.STORAGE_TYPE || 'local';
if (!['local', 's3'].includes(storageType)) throw new Error('STORAGE_TYPE must be local or s3.');

const positiveInt = (name, defaultValue) => {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
};

const icePort = positiveInt('RTC_UDP_PORT', 40000);
const icePortEnd = positiveInt('RTC_UDP_PORT_END', 40100);
if (icePortEnd > 65535 || icePort >= icePortEnd) throw new Error('Invalid RTC UDP port range.');

const { STUN_URL, TURN_URL, TURN_SECRET } = process.env;
if (STUN_URL && !/^stuns?:/.test(STUN_URL)) throw new Error('STUN_URL must be a STUN URL.');
if (TURN_URL && (!/^turns?:/.test(TURN_URL) || !TURN_SECRET)) {
  throw new Error('A TURN URL and TURN_SECRET are required to enable relay access.');
}

const iceTransportPolicy = process.env.RTC_ICE_TRANSPORT_POLICY || 'all';
if (!['all', 'relay'].includes(iceTransportPolicy)) {
  throw new Error('RTC_ICE_TRANSPORT_POLICY must be all or relay.');
}
if (iceTransportPolicy === 'relay' && !TURN_URL) {
  throw new Error('Relay-only calling requires a TURN endpoint.');
}

const bindAddress = process.env.RTC_BIND_ADDRESS;
if (bindAddress && !isIPv4(bindAddress)) throw new Error('RTC_BIND_ADDRESS must be an IPv4 address.');

const getIceServers = (guestId) => {
  const servers = STUN_URL ? [{ urls: STUN_URL }] : [];
  if (TURN_URL) {
    const username = `${Math.floor(Date.now() / 1000) + 12 * 60 * 60}:${guestId}`;
    const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: TURN_URL, username, credential });
  }
  return servers;
};

module.exports = {
  port: positiveInt('PORT', 3000),
  publicOrigin,
  env: process.env.NODE_ENV || 'development',
  storageType,
  limits: {
    maxNameLength: 50,
    maxRoomLength: 50,
    maxMessageLength: 2000,
    maxFileSize: 50 * 1024 * 1024, // 50 MB
    maxRoomHistory: positiveInt('MAX_ROOM_HISTORY', 50),
    maxRoomUsers: 100,
    maxCallParticipants: 8,
    maxSfuPeers: positiveInt('MAX_SFU_PEERS', 48),
    maxConnections: positiveInt('MAX_CHAT_CONNECTIONS', 500),
    retentionMs: positiveInt('CHAT_RETENTION_DAYS', 30) * 86400000,
    httpRateLimitWindowMs: 60 * 1000, // 1 minute
    httpRateLimitMax: positiveInt('HTTP_RATE_LIMIT_MAX', 120),
    socketRateLimitWindowMs: 10 * 1000, // 10 seconds
    socketRateLimitMax: positiveInt('SOCKET_RATE_LIMIT_MAX', 40),
  },
  paths: {
    root: ROOT_DIR,
    public: PUBLIC_DIR,
    database: path.join(DATA_DIR, 'chat.sqlite'),
    uploads: path.join(DATA_DIR, 'attachments'),
  },
  webrtc: {
    getIceServers,
    getSfuIceServers: (guestId) => iceTransportPolicy === 'relay' ? [] : getIceServers(guestId),
    iceTransportPolicy,
    peerOptions: {
      iceUseDefaultStunServer: false,
      bundlePolicy: 'max-bundle',
      icePortRange: [icePort, icePortEnd],
      ...(bindAddress ? { iceInterfaceAddresses: { udp4: bindAddress }, iceUseIpv6: false } : {}),
      iceAdditionalHostAddresses: process.env.RTC_ADVERTISED_ADDRESS ? [process.env.RTC_ADVERTISED_ADDRESS] : [],
    },
  },
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL_S3 || '',
    forcePathStyle:
      process.env.AWS_FORCE_PATH_STYLE === 'true' ||
      Boolean(process.env.AWS_ENDPOINT_URL_S3),
    bucketName: process.env.AWS_S3_BUCKET_NAME || 'chat-app-uploads',
  },
};
