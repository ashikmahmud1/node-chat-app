const { mkdirSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const config = require('../config');
const { s3, uploadS3 } = require('../middlewares/file-upload-s3');
const { upload } = require('../middlewares/file-upload');
const { hasAllowedOrigin, UUID } = require('../services/guest-session');
const { generateFiles, roomChannel, sameRoomPeer } = require('../utils/message');
const { saveDirectMessage } = require('../services/direct-messages');
const { logger } = require('../utils/logger');

const useS3 = config.storageType === 's3';
const readUpload = (useS3 ? uploadS3 : upload).single('file');

async function removeAttachment(id) {
  if (useS3) await s3.send(new DeleteObjectCommand({ Bucket: config.aws.bucketName, Key: id }));
  else await fs.rm(path.join(config.paths.uploads, id), { force: true });
}

function createFileHandlers({ users, messageStore, guestSession, io }) {
  if (!useS3) mkdirSync(config.paths.uploads, { recursive: true, mode: 0o700 });
  const activeUploads = new Set();

  async function uploadFile(req, res) {
    const guestId = guestSession.read(req);
    const sender = users.getUser(req.get('X-Chat-Connection'));
    if (!hasAllowedOrigin(req) || !guestId || !sender || sender.guestId !== guestId) {
      return res.status(403).json({ error: 'Join a group to share files.' });
    }

    if (req.get('X-Chat-Channel') !== encodeURIComponent(roomChannel(sender.room))) {
      return res.status(409).json({ error: 'The group changed before the upload started.' });
    }
    const peerId = req.get('X-Chat-Peer');
    const recipient = peerId ? sameRoomPeer(users, sender, peerId) : null;
    if (peerId && !recipient) return res.status(409).json({ error: 'This person is no longer in your group.' });
    if (activeUploads.has(sender.id) || activeUploads.size >= 20) {
      return res.status(429).json({ error: 'An upload is already in progress or the server is busy.' });
    }

    const id = randomUUID();
    req.attachmentId = id;
    const channel = roomChannel(sender.room);
    activeUploads.add(sender.id);
    try {
      messageStore.reserveAttachment({ id, name: '', room: channel, sender: guestId, recipient: recipient?.guestId ?? null });
      await new Promise((resolve, reject) => readUpload(req, res, (error) => error ? reject(error) : resolve()));
      if (!req.file || req.aborted) return res.status(400).json({ error: 'Choose a file to upload.' });
      if (users.getUser(sender.id) !== sender || (recipient && users.getUser(recipient.id) !== recipient)) {
        return res.status(409).json({ error: 'The conversation changed before the upload finished.' });
      }
      const filename = Array.from(req.file.originalname.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 180).join('');
      if (!filename) return res.status(400).json({ error: 'The file needs a name.' });
      messageStore.setAttachmentName(id, filename);
      const message = generateFiles(sender.name, id, filename);
      if (recipient) saveDirectMessage({ io, users, messageStore }, sender, recipient, message);
      else io.to(channel).emit('newMessage', messageStore.addMessage(channel, { ...message, authorId: guestId }));
      return res.status(201).json({ id });
    } finally {
      activeUploads.delete(sender.id);
    }
  }

  async function downloadFile(req, res, next) {
    const guestId = guestSession.read(req);
    const { id } = req.params;
    const file = UUID.test(id) && messageStore.getAttachment(id);
    const allowed = guestId && file && (file.recipient
      ? [file.sender, file.recipient].includes(guestId)
      : users.users.some((user) => user.guestId === guestId && roomChannel(user.room) === file.room));
    if (!allowed) return res.status(404).json({ error: 'File not found.' });

    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cache-Control', 'private, no-store');
    if (!useS3) return res.download(id, file.name, {
      root: config.paths.uploads,
      headers: { 'Content-Type': 'application/octet-stream' },
    }, (error) => {
      if (error) next(error);
    });

    let result;
    try {
      result = await s3.send(new GetObjectCommand({ Bucket: config.aws.bucketName, Key: id }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) return res.status(404).json({ error: 'File not found.' });
      throw error;
    }
    res.attachment(file.name).type('application/octet-stream');
    if (result.ContentLength !== undefined) res.set('Content-Length', String(result.ContentLength));
    if (req.method === 'HEAD') {
      result.Body.destroy();
      return res.end();
    }
    return pipeline(result.Body, res);
  }

  async function purge() {
    messageStore.purgeExpiredMessages();
    for (const { id } of messageStore.getOrphanAttachments()) {
      try {
        await removeAttachment(id);
        messageStore.forgetAttachment(id);
      } catch (error) {
        logger.warn('Could not remove expired attachment', { error: error.name });
      }
    }
  }

  return { uploadFile, downloadFile, purge };
}

module.exports = { createFileHandlers };
