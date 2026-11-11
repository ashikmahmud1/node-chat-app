const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { io } = require('socket.io-client');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
process.env.DATA_DIR = dataDir;
const { createServer } = require('../server/server');
const { MessageStore } = require('../server/utils/message-store');
const { FixedWindowRateLimiter } = require('../server/middlewares/rate-limit.middleware');
const { generateMessage } = require('../server/utils/message');

describe('HTTP and Socket.IO integration', function () {
  this.timeout(5000);
  let server;
  let origin;
  let clients;

  const request = (socket, event, data) => new Promise((resolve, reject) => {
    socket.timeout(2000).emit(event, data, (timeout, error, result) => {
      if (timeout || error) reject(timeout || new Error(error));
      else resolve(result);
    });
  });

  async function connect(cookie) {
    if (!cookie) {
      const session = await fetch(origin + '/api/session', { method: 'POST' });
      assert.equal(session.status, 200);
      cookie = session.headers.get('set-cookie').split(';')[0];
    }
    const socket = io(origin, { forceNew: true, reconnection: false, extraHeaders: { Cookie: cookie } });
    clients.push(socket);
    await once(socket, 'connect');
    return { socket, cookie };
  }

  async function guest(name, room) {
    const client = await connect();
    await request(client.socket, 'join', { name, room });
    return client;
  }

  function upload(client, text, peer) {
    const form = new FormData();
    form.append('file', new Blob([text]), 'notes.txt');
    return fetch(origin + '/api/files', {
      method: 'POST',
      body: form,
      headers: {
        Cookie: client.cookie,
        'X-Chat-Connection': client.socket.id,
        'X-Chat-Channel': encodeURIComponent('chat:engineering'),
        ...(peer ? { 'X-Chat-Peer': peer.socket.id } : {}),
      },
    });
  }

  beforeEach(async () => {
    clients = [];
    server = createServer(new MessageStore(50, ':memory:'));
    server.httpServer.listen(0, '127.0.0.1');
    await once(server.httpServer, 'listening');
    origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  });

  afterEach(async () => {
    for (const socket of clients) socket.disconnect();
    await server.close();
  });

  after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('serves the app and Socket.IO bundle with a same-origin guest session', async () => {
    const home = await fetch(origin);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
    const bundle = await fetch(origin + '/socket.io/socket.io.min.js');
    assert.equal(bundle.status, 200);
    const rejected = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: 'https://another.example' } });
    assert.equal(rejected.status, 403);
    const session = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin } });
    assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(origin + '/api/rtc-config')).status, 401);
  });

  it('validates payloads and names and returns the correct history on a case-insensitive room switch', async () => {
    const alice = await guest('Alice', 'Engineering');
    const bob = await connect();
    await assert.rejects(request(bob.socket, 'join', null), /display name/);
    await assert.rejects(request(bob.socket, 'join', { name: 'alice', room: 'engineering' }), /already in use/);
    await request(bob.socket, 'join', { name: 'Bob', room: 'Design' });
    await assert.rejects(request(bob.socket, 'join', { name: 'Bob', room: 'Engineering' }), /Already joined/);
    await assert.rejects(request(alice.socket, 'createLocationMessage', { latitude: 120, longitude: 90 }), /Invalid location/);
    await request(alice.socket, 'createMessage', { text: 'Engineering history' });
    const nextRoom = once(bob.socket, 'room:state');
    await request(bob.socket, 'room:switch', { room: 'engineering' });
    const [state] = await nextRoom;
    assert.equal(state.user.room, 'Engineering');
    assert.deepEqual(state.messages.map((message) => message.text), ['Engineering history']);
  });

  it('keeps ownership after reconnect and rejects edits from a guest using the same display name', async () => {
    const alice = await guest('Alice', 'Engineering');
    const { id } = await request(alice.socket, 'createMessage', { text: 'Original message' });
    await request(alice.socket, 'room:switch', { room: 'Design' });
    const other = await guest('Alice', 'Engineering');
    await assert.rejects(request(other.socket, 'message:edit', { messageId: id, text: 'Changed' }), /Unable to edit/);
    await assert.rejects(request(other.socket, 'message:delete', { messageId: id }), /Unable to delete/);
    await request(other.socket, 'room:switch', { room: 'Support' });
    alice.socket.disconnect();
    const returning = await connect(alice.cookie);
    await request(returning.socket, 'join', { name: 'Alice renamed', room: 'engineering' });
    await request(returning.socket, 'message:edit', { messageId: id, text: 'Owner edit' });
    await request(returning.socket, 'message:reaction', { messageId: id, emoji: '👍' });
    await request(returning.socket, 'message:delete', { messageId: id });
  });

  it('lets a returning guest reclaim their own room session', async () => {
    const first = await guest('Alice', 'Engineering');
    const second = await connect(first.cookie);
    const disconnected = once(first.socket, 'disconnect');
    await request(second.socket, 'join', { name: 'Alice', room: 'engineering' });
    assert.equal((await disconnected)[0], 'io server disconnect');
    await request(second.socket, 'createMessage', { text: 'Back online' });
  });

  it('delivers and saves direct messages for the two guests in the same group', async () => {
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'engineering');
    const outside = await guest('Outside', 'Design');
    const received = once(bob.socket, 'dm:message');
    const sent = once(alice.socket, 'dm:message');
    await request(alice.socket, 'dm:send', { peerId: bob.socket.id, text: 'Private update' });
    const [{ message }] = await received;
    assert.deepEqual((await sent)[0].message, message);
    assert.deepEqual(await request(bob.socket, 'dm:history', { peerId: alice.socket.id }), [message]);
    await assert.rejects(request(outside.socket, 'dm:send', { peerId: alice.socket.id, text: 'Cross-room message' }), /no longer in your group/);
    await assert.rejects(request(outside.socket, 'dm:history', { peerId: bob.socket.id }), /no longer in your group/);
  });

  it('publishes private attachments through the upload route and limits downloads to participants', async () => {
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const outside = await guest('Outside', 'Engineering');
    const received = once(bob.socket, 'dm:message');
    const result = await upload(alice, 'Attachment body', bob);
    assert.equal(result.status, 201);
    const { id } = await result.json();
    const [{ message }] = await received;
    assert.equal(message.id, id);
    assert.equal(message.filename, 'notes.txt');
    const denied = await fetch(origin + message.url, { headers: { Cookie: outside.cookie } });
    assert.equal(denied.status, 404);
    const accepted = await fetch(origin + message.url, { headers: { Cookie: bob.cookie } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('content-type'), 'application/octet-stream');
    assert.match(accepted.headers.get('content-disposition'), /^attachment/);
    assert.equal(await accepted.text(), 'Attachment body');
    assert.equal((await fetch(origin + '/data/message-history.json')).status, 404);
  });

  it('revokes group attachment downloads when the message is deleted or a guest leaves', async () => {
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const result = await upload(alice, 'Room file');
    assert.equal(result.status, 201);
    const { id } = await result.json();
    const download = () => fetch(origin + '/api/files/' + id, { headers: { Cookie: bob.cookie } });
    assert.equal((await download()).status, 200);
    await request(bob.socket, 'room:switch', { room: 'Design' });
    assert.equal((await download()).status, 404);
    await request(bob.socket, 'room:switch', { room: 'Engineering' });
    await request(alice.socket, 'message:delete', { messageId: id });
    assert.equal((await download()).status, 404);
  });

  it('rejects unauthorized media joins and enforces server-owned private call state', async () => {
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const outside = await guest('Outside', 'Design');
    await assert.rejects(request(alice.socket, 'sfu:join', { sessionId: 'room:chat:design', mode: 'video' }), /cannot join/);
    await request(bob.socket, 'presence:update', { status: 'dnd' });
    await assert.rejects(request(alice.socket, 'call:start', { peerId: bob.socket.id, mode: 'video' }), /unavailable/);
    await request(bob.socket, 'presence:update', { status: 'online' });

    const incoming = once(bob.socket, 'call:incoming');
    const { id } = await request(alice.socket, 'call:start', { peerId: bob.socket.id, mode: 'video' });
    assert.equal((await incoming)[0].id, id);
    await assert.rejects(request(alice.socket, 'sfu:join', { sessionId: 'private:' + id, mode: 'video' }), /cannot join/);
    await assert.rejects(request(outside.socket, 'call:accept', { id }), /no longer ringing/);
    await request(outside.socket, 'call:end', { id });
    const accepted = once(alice.socket, 'call:accepted');
    await request(bob.socket, 'call:accept', { id });
    assert.equal((await accepted)[0].id, id);
    await assert.rejects(request(outside.socket, 'sfu:join', { sessionId: 'private:' + id, mode: 'video' }), /cannot join/);

    const ended = once(alice.socket, 'call:ended');
    await request(bob.socket, 'room:switch', { room: 'Design' });
    assert.deepEqual((await ended)[0], { id, reason: 'left', wasConnected: false, durationSec: 0 });
  });

  it('persists room messages and the session signing key across restarts', () => {
    const database = path.join(dataDir, 'persistence.sqlite');
    const first = new MessageStore(1, database);
    const key = first.getSessionKey();
    first.addMessage('chat:engineering', generateMessage('Alice', 'Old'));
    first.addMessage('chat:engineering', generateMessage('Alice', 'Retained'));
    first.close();
    const second = new MessageStore(1, database);
    assert.deepEqual(second.getSessionKey(), key);
    assert.deepEqual(second.getMessages('chat:engineering').map((message) => message.text), ['Retained']);
    second.close();
  });

  it('enforces a fixed request quota', () => {
    const limiter = new FixedWindowRateLimiter({ max: 2 });
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);
    assert.equal(limiter.consume('b').allowed, true);
  });
});
