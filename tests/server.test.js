const fs = require('fs');
const path = require('path');
const { expect } = require('expect');
const config = require('../server/config');
const { uploadFile, downloadFile } = require('../server/controllers/file.controller');
const { fileFilter } = require('../server/middlewares/file-upload');
const { SlidingWindowRateLimiter, createHttpRateLimiter } = require('../server/middlewares/rate-limit.middleware');
const { notFoundHandler, errorHandler } = require('../server/middlewares/error.middleware');
const { registerChatHandlers } = require('../server/sockets/chat.handler');
const { registerPrivateHandlers } = require('../server/sockets/private.handler');
const { registerCallHandlers } = require('../server/sockets/call.handler');
const { Users } = require('../server/utils/users');
const { MessageStore } = require('../server/utils/message-store');

const createMockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    downloadedFile: null,
    headersSent: false,
    setHeader(key, val) {
      this.headers[key] = val;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    download(filePath, filename, cb) {
      this.downloadedFile = { filePath, filename };
      if (cb) cb(null);
      return this;
    },
  };
  return res;
};

const createMockSocketEnv = () => {
  const users = new Users();
  const messageStore = new MessageStore(10, null);
  const emitted = [];
  const broadcasted = [];

  const io = {
    to(room) {
      return {
        emit(event, data) {
          emitted.push({ room, event, data });
        },
      };
    },
  };

  const createSocket = (id) => {
    const handlers = {};
    const joinedRooms = [];
    const directEmits = [];

    const socket = {
      id,
      joinedRooms,
      directEmits,
      on(event, fn) {
        handlers[event] = fn;
      },
      join(room) {
        joinedRooms.push(room);
      },
      emit(event, data) {
        directEmits.push({ event, data });
      },
      broadcast: {
        to(target) {
          return {
            emit(event, data) {
              broadcasted.push({ from: id, target, event, data });
            },
          };
        },
      },
      trigger(event, ...args) {
        if (handlers[event]) {
          return handlers[event](...args);
        }
        return undefined;
      },
    };

    registerChatHandlers(io, socket, users, messageStore);
    registerPrivateHandlers(io, socket, users);
    registerCallHandlers(io, socket, users);

    return socket;
  };

  return { users, messageStore, io, emitted, broadcasted, createSocket };
};

describe('Controllers, Middlewares & Socket Handlers', () => {
  describe('File Controller, Security Filter & Rate Limiter', () => {
    it('uploadFile should return 400 when req.file is missing', () => {
      const req = {};
      const res = createMockRes();

      uploadFile(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'No file provided for upload.' });
    });

    it('uploadFile should return 200 with uploaded file metadata and normalize S3 key', () => {
      const fakeFile = { key: '12345-s3.png', originalname: 's3.png' };
      const req = { file: fakeFile };
      const res = createMockRes();

      uploadFile(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.file.filename).toBe('12345-s3.png');
    });

    it('fileFilter should block dangerous executable extensions (.exe, .sh, .php) and allow safe files', () => {
      let rejectedErr = null;
      fileFilter({}, { originalname: 'malware.exe' }, (err) => {
        rejectedErr = err;
      });
      expect(rejectedErr).toBeDefined();
      expect(rejectedErr.message).toContain('not permitted');

      let accepted = false;
      fileFilter({}, { originalname: 'document.pdf' }, (err, allow) => {
        expect(err).toBeNull();
        accepted = allow;
      });
      expect(accepted).toBe(true);
    });

    it('SlidingWindowRateLimiter should enforce request quotas within window', () => {
      const limiter = new SlidingWindowRateLimiter({ windowMs: 5000, max: 2 });
      expect(limiter.consume('client-1').allowed).toBe(true);
      expect(limiter.consume('client-1').allowed).toBe(true);
      expect(limiter.consume('client-1').allowed).toBe(false);
    });

    it('downloadFile should block path traversal attempts with 400', () => {
      const req = { params: { filename: '../server/server.js' } };
      const res = createMockRes();

      downloadFile(req, res, () => {});

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid file name.' });
    });

    it('downloadFile should return 404 when file does not exist', () => {
      const req = { params: { filename: 'missing-file-9999.txt' } };
      const res = createMockRes();

      downloadFile(req, res, () => {});

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'File not found.' });
    });

    it('downloadFile should serve existing files with sandbox CSP and nosniff headers', () => {
      const sampleFilename = `test-${Date.now()}.txt`;
      const sampleFilePath = path.join(config.paths.uploads, sampleFilename);
      fs.writeFileSync(sampleFilePath, 'sample content');

      try {
        const req = { params: { filename: sampleFilename } };
        const res = createMockRes();

        downloadFile(req, res, () => {});

        expect(res.statusCode).toBe(200);
        expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
        expect(res.headers['Content-Security-Policy']).toContain('sandbox');
        expect(res.downloadedFile).toEqual({
          filePath: sampleFilePath,
          filename: sampleFilename,
        });
      } finally {
        if (fs.existsSync(sampleFilePath)) {
          fs.unlinkSync(sampleFilePath);
        }
      }
    });

    it('notFoundHandler and errorHandler should format JSON error responses', () => {
      const res404 = createMockRes();
      notFoundHandler({}, res404);
      expect(res404.statusCode).toBe(404);
      expect(res404.body).toEqual({ error: 'Resource not found' });

      const res500 = createMockRes();
      errorHandler(new Error('Custom error'), {}, res500, () => {});
      expect(res500.statusCode).toBe(500);
      expect(res500.body).toEqual({ error: 'Custom error' });
    });

    it('errorHandler should delegate to next(err) when headersSent is true to prevent ERR_HTTP_HEADERS_SENT', () => {
      const res = createMockRes();
      res.headersSent = true;
      let nextCalledWith = null;
      const testErr = new Error('Stream error after headers');

      errorHandler(testErr, {}, res, (err) => {
        nextCalledWith = err;
      });

      expect(nextCalledWith).toBe(testErr);
      expect(res.body).toBeNull();
    });

    it('createHttpRateLimiter should bypass setting headers when headersSent is true to prevent ERR_HTTP_HEADERS_SENT', () => {
      const limiterMiddleware = createHttpRateLimiter();
      const res = createMockRes();
      res.headersSent = true;
      let nextCalled = false;

      limiterMiddleware({}, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(res.headers['X-RateLimit-Limit']).toBeUndefined();
    });

    it('notFoundHandler should return early when headersSent is true to prevent ERR_HTTP_HEADERS_SENT', () => {
      const res = createMockRes();
      res.headersSent = true;

      notFoundHandler({}, res);

      expect(res.body).toBeNull();
    });
  });

  describe('Socket.IO Chat, Room History, Edit/Delete/Reactions, Presence & Call Handlers', () => {
    it('should validate join parameters, reject duplicate usernames, and replay room message history to new joiners', () => {
      const { createSocket, emitted, broadcasted, users } = createMockSocketEnv();
      const socketA = createSocket('socket-a');
      const socketB = createSocket('socket-b');

      let joinError = null;
      socketA.trigger('join', { name: '   ', room: 'General' }, (err) => {
        joinError = err;
      });
      expect(joinError).toContain('Valid display name and room name');

      socketA.trigger('join', { name: 'Ashik', room: 'DevRoom' }, () => {});
      expect(users.getUser('socket-a')).toEqual({
        id: 'socket-a',
        name: 'Ashik',
        room: 'DevRoom',
        status: 'online',
      });

      socketA.trigger('createMessage', { text: 'Welcome message stored in history' }, () => {});

      let duplicateErr = null;
      socketB.trigger('join', { name: 'ashik', room: 'devroom' }, (err) => {
        duplicateErr = err;
      });
      expect(duplicateErr).toContain('already in use');

      socketB.trigger('join', { name: 'Jen', room: 'devroom' }, () => {});
      const historyEmit = socketB.directEmits.find((e) => e.event === 'roomHistory');
      expect(historyEmit).toBeDefined();
      expect(historyEmit.data.length).toBe(1);
      expect(historyEmit.data[0].text).toBe('Welcome message stored in history');
      expect(emitted.some((e) => e.event === 'updateUserList' && e.room === 'DevRoom')).toBe(true);
      expect(broadcasted.some((b) => b.event === 'newMessage')).toBe(true);
    });

    it('should support message editing, emoji reactions, and message deletion', () => {
      const { createSocket, emitted, messageStore } = createMockSocketEnv();
      const socketA = createSocket('socket-a');
      const socketB = createSocket('socket-b');

      socketA.trigger('join', { name: 'Ashik', room: 'DevRoom' }, () => {});
      socketB.trigger('join', { name: 'Jen', room: 'DevRoom' }, () => {});

      socketA.trigger('createMessage', { text: 'Initial message' }, () => {});
      const storedMsg = messageStore.getMessages('DevRoom')[0];
      expect(storedMsg.text).toBe('Initial message');

      // Non-owner cannot edit Ashik's message
      let nonOwnerEditErr = null;
      socketB.trigger(
        'message:edit',
        { messageId: storedMsg.id, text: 'Unauthorized edit' },
        (err) => {
          nonOwnerEditErr = err;
        }
      );
      expect(nonOwnerEditErr).toBe('Unable to edit message.');

      // Owner edits message
      socketA.trigger(
        'message:edit',
        { messageId: storedMsg.id, text: 'Updated enterprise message' },
        () => {}
      );
      expect(messageStore.getMessages('DevRoom')[0].text).toBe('Updated enterprise message');
      expect(messageStore.getMessages('DevRoom')[0].edited).toBe(true);
      expect(emitted.some((e) => e.event === 'message:edited')).toBe(true);

      // Jen reacts with 👍
      socketB.trigger(
        'message:reaction',
        { messageId: storedMsg.id, emoji: '👍' },
        () => {}
      );
      expect(messageStore.getMessages('DevRoom')[0].reactions['👍']).toEqual(['Jen']);
      expect(emitted.some((e) => e.event === 'message:reaction-updated')).toBe(true);

      // Owner deletes message
      socketA.trigger('message:delete', { messageId: storedMsg.id }, () => {});
      expect(messageStore.getMessages('DevRoom').length).toBe(0);
      expect(emitted.some((e) => e.event === 'message:deleted')).toBe(true);
    });

    it('should update presence status and automatically reject incoming calls when recipient is on DND', () => {
      const { createSocket } = createMockSocketEnv();
      const socketA = createSocket('socket-a');
      const socketB = createSocket('socket-b');

      socketA.trigger('join', { name: 'Ashik', room: 'DevRoom' }, () => {});
      socketB.trigger('join', { name: 'Jen', room: 'DevRoom' }, () => {});

      // Jen sets status to Do Not Disturb ('dnd')
      socketB.trigger('presence:update', { status: 'dnd' }, () => {});

      // Ashik tries to audio call Jen while Jen is on DND
      socketA.directEmits.length = 0;
      socketA.trigger('initializeAudioCall', 'socket-b');
      expect(socketA.directEmits.some((e) => e.event === 'userBusy')).toBe(true);

      // Ashik tries to call an offline user
      socketA.directEmits.length = 0;
      socketA.trigger('initializeVideoCall', 'offline-socket-id');
      expect(socketA.directEmits.some((e) => e.event === 'userOffline')).toBe(true);
    });

    it('should forward callEnded and videoCallEnded with duration and metadata to peer', () => {
      const { createSocket, broadcasted } = createMockSocketEnv();
      const socketA = createSocket('socket-a');
      const socketB = createSocket('socket-b');

      socketA.trigger('join', { name: 'Ashik', room: 'DevRoom' }, () => {});
      socketB.trigger('join', { name: 'Jen', room: 'DevRoom' }, () => {});

      // Call ended with structured payload
      socketA.trigger('callEnded', {
        userid: 'socket-b',
        mode: 'audio',
        durationSec: 145,
        reason: 'Call completed',
      });

      const callEndedEvent = broadcasted.find(
        (b) => b.from === 'socket-a' && b.target === 'socket-b' && b.event === 'callEnded'
      );
      expect(callEndedEvent).toBeDefined();
      expect(callEndedEvent.data).toEqual({
        user: {
          id: 'socket-a',
          name: 'Ashik',
          room: 'DevRoom',
          status: 'online',
        },
        userid: 'socket-b',
        mode: 'audio',
        durationSec: 145,
        reason: 'Call completed',
      });

      // Video call ended with legacy string userid
      socketB.trigger('videoCallEnded', 'socket-a');
      const videoCallEndedEvent = broadcasted.find(
        (b) => b.from === 'socket-b' && b.target === 'socket-a' && b.event === 'videoCallEnded'
      );
      expect(videoCallEndedEvent).toBeDefined();
      expect(videoCallEndedEvent.data).toEqual({
        user: {
          id: 'socket-b',
          name: 'Jen',
          room: 'DevRoom',
          status: 'online',
        },
        userid: 'socket-a',
      });
    });

    it('should support live group switching via room:switch and broadcast updateRoomList', () => {
      const { createSocket, emitted, users, messageStore } = createMockSocketEnv();
      const socketA = createSocket('socket-a');

      socketA.trigger('join', { name: 'Ashik', room: 'Engineering' }, () => {});
      expect(users.getUser('socket-a').room).toBe('Engineering');
      expect(
        emitted.some(
          (e) =>
            e.event === 'updateRoomList' &&
            Array.isArray(e.data) &&
            e.data.includes('Engineering')
        )
      ).toBe(true);

      messageStore.addMessage('Design', { id: 'design-1', from: 'Jen', text: 'Design spec' });

      let switchRes = null;
      socketA.trigger('room:switch', { room: 'Design' }, (err, res) => {
        expect(err).toBeNull();
        switchRes = res;
      });

      expect(switchRes).toEqual({ room: 'Design' });
      expect(users.getUser('socket-a').room).toBe('Design');
      expect(
        socketA.directEmits.some(
          (e) => e.event === 'roomHistory' && e.data.some((m) => m.text === 'Design spec')
        )
      ).toBe(true);
    });

    it('should persist and reload MessageStore snapshots on disk', () => {
      const tempPersistFile = path.join(config.paths.uploads, `test-history-${Date.now()}.json`);
      try {
        const store1 = new MessageStore(10, tempPersistFile);
        store1.addMessage('EnterpriseRoom', { id: 'msg-1', from: 'Ashik', text: 'Persisted' });

        const store2 = new MessageStore(10, tempPersistFile);
        const loaded = store2.getMessages('EnterpriseRoom');
        expect(loaded.length).toBe(1);
        expect(loaded[0].text).toBe('Persisted');
      } finally {
        if (fs.existsSync(tempPersistFile)) {
          fs.unlinkSync(tempPersistFile);
        }
      }
    });
  });
});
