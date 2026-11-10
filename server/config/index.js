const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOAD_DIR = path.join(ROOT_DIR, 'data');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',
  storageType: process.env.STORAGE_TYPE || 'local', // 'local' or 's3'
  limits: {
    maxNameLength: 50,
    maxRoomLength: 50,
    maxMessageLength: 2000,
    maxFileSize: 50 * 1024 * 1024, // 50 MB
  },
  paths: {
    root: ROOT_DIR,
    public: PUBLIC_DIR,
    uploads: UPLOAD_DIR,
  },
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    bucketName: process.env.AWS_S3_BUCKET_NAME || '',
  },
};
