const fs = require('fs');
const path = require('path');
const { expect } = require('expect');
const config = require('../server/config');
const { uploadFile, downloadFile } = require('../server/controllers/file.controller');
const { notFoundHandler, errorHandler } = require('../server/middlewares/error.middleware');
const { registerChatHandlers } = require('../server/sockets/chat.handler');
const { registerPrivateHandlers } = require('../server/sockets/private.handler');
const { registerCallHandlers } = require('../server/sockets/call.handler');
const { Users } = require('../server/utils/users');

const createMockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    downloadedFile: null,
    headersSent: false,
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

    registerChatHandlers(io, socket, users);
    registerPrivateHandlers(io, socket, users);
    registerCallHandlers(io, socket, users);

    return socket;
  };

  return { users, io, emitted, broadcasted, createSocket };
};

describe('Controllers, Middlewares & Socket Handlers', () => {
  describe('File Controller & Error Middleware', () => {
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

    it('downloadFile should serve existing files from data directory', () => {
      const sampleFilename = `test-${Date.now()}.txt`;
      const sampleFilePath = path.join(config.paths.uploads, sampleFilename);
      fs.writeFileSync(sampleFilePath, 'sample content');

      try {
        const req = { params: { filename: sampleFilename } };
        const res = createMockRes();

        downloadFile(req, res, () => {});

        expect(res.statusCode).toBe(200);
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
  });

  describe('Socket.IO Chat, Private & Call Handlers', () => {
    it('should validate join parameters, reject duplicate usernames in same room, and normalize room case', () => {
      const { createSocket, emitted, broadcasted, users } = createMockSocketEnv();
      const socketA = createSocket('socket-a');
      const socketB = createSocket('socket-b');

      let joinError = null;
      socketA.trigger('join', { name: '   ', room: 'General' }, (err) => {
        joinError = err;
      });
      expect(joinError).toContain('Valid display name and room name');

      let successErr = 'not-called';
      socketA.trigger('join', { name: 'Ashik', room: 'DevRoom' }, (err) => {
        successErr = err;
      });

      expect(successErr).toBeUndefined();
      expect(users.getUser('socket-a')).toEqual({
        id: 'socket-a',
        name: 'Ashik',
        room: 'DevRoom',
      });
      expect(emitted.some((e) => e.event === 'updateUserList' && e.room === 'DevRoom')).toBe(true);
      expect(socketA.directEmits[0].event).toBe('newMessage');
      expect(socketA.directEmits[0].data.text).toBe('Welcome to the chat app');
      expect(broadcasted[0].event).toBe('newMessage');
      expect(broadcasted[0].data.text).toBe('Ashik has joined.');

      // Duplicate username in same room (case-insensitive) should be rejected
      let duplicateErr = null;
      socketB.trigger('join', { name: 'ashik', room: 'devroom' }, (err) => {
        duplicateErr = err;
      });
      expect(duplicateErr).toContain('already in use');

      // Different username joining 'devroom' should join canonical 'DevRoom'
      let secondJoinErr = 'not-called';
      socketB.trigger('join', { name: 'Jen', room: 'devroom' }, (err) => {
        secondJoinErr = err;
      });
      expect(secondJoinErr).toBeUndefined();
      expect(users.getUser('socket-b').room).toBe('DevRoom');
    });

    it('should handle public messages, location messages, file messages, and disconnect', () => {
      const { createSocket, emitted, users } = createMockSocketEnv();
      const socketA = createSocket('socket-a');
      socketA.trigger('join', { name: 'Ashik', room: 'DevRoom' }, () => {});

      emitted.length = 0;
      let ackCalled = false;
      socketA.trigger('createMessage', { text: 'Hello World' }, () => {
        ackCalled = true;
      });

      expect(ackCalled).toBe(true);
      expect(emitted.length).toBe(1);
      expect(emitted[0].event).toBe('newMessage');
      expect(emitted[0].data).toMatchObject({ from: 'Ashik', text: 'Hello World' });

      socketA.trigger('createLocationMessage', { latitude: 23.16, longitude: 89.21 });
      expect(emitted[1].event).toBe('newLocationMessage');
      expect(emitted[1].data.url).toContain('23.16,89.21');

      socketA.trigger('newFileMessage', { filename: '123-doc.pdf' });
      expect(emitted[2].event).toBe('newFileMessage');
      expect(emitted[2].data).toMatchObject({
        from: 'Ashik',
        fileUrl: '123-doc.pdf',
        fileurl: '123-doc.pdf',
      });

      socketA.trigger('disconnect');
      expect(users.getUser('socket-a')).toBeUndefined();
      expect(emitted.some((e) => e.event === 'newMessage' && e.data.text === 'Ashik has left.')).toBe(
        true
      );
    });

    it('should handle private messaging, private files, private locations, and call signaling', () => {
      const { createSocket, broadcasted } = createMockSocketEnv();
      const socketA = createSocket('socket-a');
      const socketB = createSocket('socket-b');

      socketA.trigger('join', { name: 'Ashik', room: 'DevRoom' }, () => {});
      socketB.trigger('join', { name: 'Jen', room: 'DevRoom' }, () => {});
      broadcasted.length = 0;

      // Self-messaging should be ignored
      socketA.trigger('createPrivateMessage', {
        userid: 'socket-a',
        message: 'Self hello',
      });
      expect(broadcasted.length).toBe(0);

      socketA.trigger('createPrivateMessage', {
        userid: 'socket-b',
        message: 'Private hello',
      });
      expect(broadcasted[0]).toMatchObject({
        from: 'socket-a',
        target: 'socket-b',
        event: 'newPrivateMessage',
      });
      expect(broadcasted[0].data.message).toBe('Private hello');

      socketB.trigger('privateMessageSendSuccessful', {
        userid: 'socket-a',
        message: 'Private hello',
      });
      expect(broadcasted[1]).toMatchObject({
        from: 'socket-b',
        target: 'socket-a',
        event: 'privateMessageSuccessfulAdd',
      });

      socketA.trigger('createPrivateLocationMessage', {
        userid: 'socket-b',
        latitude: 23.81,
        longitude: 90.41,
      });
      expect(broadcasted[2]).toMatchObject({
        from: 'socket-a',
        target: 'socket-b',
        event: 'newPrivateLocationMessage',
      });

      socketA.trigger('initializeAudioCall', 'socket-b');
      expect(broadcasted[3]).toMatchObject({
        from: 'socket-a',
        target: 'socket-b',
        event: 'incomingCall',
      });

      socketA.trigger('initializeVideoCall', 'socket-b');
      expect(broadcasted[4]).toMatchObject({
        from: 'socket-a',
        target: 'socket-b',
        event: 'incomingVideoCall',
      });
    });
  });
});
