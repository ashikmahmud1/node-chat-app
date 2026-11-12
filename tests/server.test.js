const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createECDH, randomBytes } = require('node:crypto');
const { io } = require('socket.io-client');
const webPush = require('web-push');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
process.env.DATA_DIR = dataDir;
const { createServer } = require('../server/server');
const { MessageStore } = require('../server/utils/message-store');
const { FixedWindowRateLimiter } = require('../server/middlewares/rate-limit.middleware');
const { directConversation, generateMessage } = require('../server/utils/message');

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
    ({ guestId: client.guestId } = await request(client.socket, 'join', { name, room }));
    return client;
  }

  function upload(client, text, peer, replyTo) {
    const form = new FormData();
    form.append('file', new Blob([text]), 'notes.txt');
    return fetch(origin + '/api/files', {
      method: 'POST',
      body: form,
      headers: {
        Cookie: client.cookie,
        'X-Chat-Connection': client.socket.id,
        'X-Chat-Channel': encodeURIComponent('chat:engineering'),
        ...(peer ? { 'X-Chat-Peer': peer.guestId } : {}),
        ...(replyTo ? { 'X-Chat-Reply-To': replyTo } : {}),
      },
    });
  }

  async function startServer(database = ':memory:', options) {
    server = createServer(new MessageStore(50, database), options);
    server.httpServer.listen(0, '127.0.0.1');
    await once(server.httpServer, 'listening');
    origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  }

  function pushRequest(client, route = '', method = 'GET', body) {
    return fetch(origin + '/api/push' + route, {
      method,
      headers: { Cookie: client.cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function pushSubscription(endpoint) {
    const keys = createECDH('prime256v1');
    return {
      endpoint,
      keys: { p256dh: keys.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    };
  }

  async function waitForPush(deliveries, count) {
    for (let attempt = 0; attempt < 160 && deliveries.length < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(deliveries.length, count);
  }

  beforeEach(async () => {
    clients = [];
    await startServer();
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
    await request(alice.socket, 'dm:send', { peerId: bob.guestId, text: 'Private update' });
    const [{ message }] = await received;
    assert.deepEqual((await sent)[0].message, message);
    assert.deepEqual((await request(bob.socket, 'dm:history', { peerId: alice.guestId })).messages, [message]);
    await assert.rejects(request(outside.socket, 'dm:send', { peerId: alice.guestId, text: 'Cross-room message' }), /unavailable/);
    await assert.rejects(request(outside.socket, 'dm:history', { peerId: bob.guestId }), /unavailable/);
  });

  it('delivers a retained offline backlog with unread counts and participant-scoped receipts', async () => {
    const database = path.join(dataDir, 'offline-delivery.sqlite');
    await server.close();
    await startServer(database);
    let alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const departed = once(alice.socket, 'updateUserList');
    bob.socket.disconnect();
    await departed;
    const send = (text) => request(alice.socket, 'dm:send', { peerId: bob.guestId, text });
    await assert.rejects(send('Unestablished offline contact'), /unavailable/);

    const firstReturn = await connect(bob.cookie);
    await request(firstReturn.socket, 'join', { name: 'Bob', room: 'engineering' });
    const first = await send('First exchange');
    const leftAgain = once(alice.socket, 'updateUserList');
    firstReturn.socket.disconnect();
    await leftAgain;

    const queued = [];
    for (let index = 1; index <= 51; index++) {
      if (index === 26) {
        alice.socket.disconnect();
        alice = { ...await connect(alice.cookie), guestId: alice.guestId };
        await request(alice.socket, 'join', { name: 'Alice', room: 'engineering' });
      }
      queued.push(await send('Offline ' + index));
    }
    const file = await upload(alice, 'Offline attachment body', bob);
    assert.equal(file.status, 201);
    const { id: fileId } = await file.json();
    await assert.rejects(request(alice.socket, 'call:start', { peerId: bob.guestId, mode: 'audio' }), /has not enabled call notifications/);

    const substitute = await guest('Bob', 'Engineering');
    const unknown = await request(substitute.socket, 'dm:history', { peerId: alice.guestId });
    assert.deepEqual(unknown, { messages: [], before: null });
    assert.deepEqual(await request(substitute.socket, 'dm:read', { peerId: alice.guestId, messageIds: [queued[0].id] }), []);
    const substituteLeft = once(alice.socket, 'updateUserList');
    substitute.socket.disconnect();
    await substituteLeft;

    alice.socket.disconnect();
    await server.close();
    await startServer(database);
    alice = { ...await connect(alice.cookie), guestId: alice.guestId };
    await request(alice.socket, 'join', { name: 'Alice', room: 'Engineering' });

    const returned = await connect(bob.cookie);
    const joined = once(returned.socket, 'room:state');
    await request(returned.socket, 'join', { name: 'Bob', room: 'engineering' });
    const [state] = await joined;
    assert.deepEqual(state.directThreads.map(({ peer, unread }) => [peer.guestId, peer.name, unread]),
      [[alice.guestId, 'Alice', 53]]);
    const response = await fetch(origin + '/api/files/' + fileId, { headers: { Cookie: returned.cookie } });
    assert.equal(await response.text(), 'Offline attachment body');
    const page = await request(returned.socket, 'dm:history', { peerId: alice.guestId });
    assert.equal(page.messages.length, 50);
    assert.equal(page.messages.at(-1).id, fileId);
    assert.ok(page.messages.every((message) => !message.readAt));
    const older = await request(returned.socket, 'dm:history', { peerId: alice.guestId, before: page.before });
    assert.deepEqual(older.messages.map((message) => message.id), [first.id, queued[0].id, queued[1].id]);
    assert.equal(older.before, null);
    const target = queued.at(-1).id;
    assert.deepEqual(await request(alice.socket, 'dm:read', { peerId: bob.guestId, messageIds: [target] }), []);
    const event = once(alice.socket, 'dm:read');
    const read = () => request(returned.socket, 'dm:read', { peerId: alice.guestId, messageIds: [target] });
    const [receipt] = await read();
    assert.equal(receipt.id, target);
    assert.ok(receipt.readAt > 0);
    const [broadcast] = await event;
    assert.deepEqual(broadcast.receipts, [receipt]);
    assert.equal(broadcast.peer.guestId, bob.guestId);
    assert.deepEqual(await read(), [receipt]);
    const refreshed = await request(alice.socket, 'dm:history', { peerId: bob.guestId });
    assert.equal(refreshed.messages.find((message) => message.id === target).readAt, receipt.readAt);
    assert.equal(refreshed.messages.find((message) => message.id === fileId).readAt, undefined);
  });

  it('sends private Web Push alerts for closed chats and validates notification ownership', async () => {
    const deliveries = [];
    await server.close();
    await startServer(':memory:', { sendPush: async (subscription, payload, options) => {
      const wire = webPush.generateRequestDetails(subscription, payload, options);
      deliveries.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options, wire });
    } });
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const outside = await guest('Charlie', 'Engineering');
    const subscription = pushSubscription('https://fcm.googleapis.com/fcm/send/test-registration');
    assert.equal((await fetch(origin + '/api/push')).status, 401);
    const registration = await pushRequest(bob, '/subscription', 'PUT', subscription);
    assert.equal(registration.status, 204);
    const invalid = await pushRequest(bob, '/subscription', 'PUT', {
      ...subscription, endpoint: 'https://127.0.0.1/internal',
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await (await pushRequest(outside, '/subscription', 'PATCH', { endpoint: subscription.endpoint })).json(),
      { enabled: false });

    const send = (text) => request(alice.socket, 'dm:send', { peerId: bob.guestId, text });
    await request(bob.socket, 'push:visibility', { foreground: true });
    await send('Foreground');
    assert.deepEqual(deliveries, []);
    const left = once(alice.socket, 'updateUserList');
    bob.socket.disconnect();
    await left;
    const { id } = await send('Private lock screen text');
    await waitForPush(deliveries, 1);
    const [delivery] = deliveries;
    assert.equal(delivery.endpoint, subscription.endpoint);
    assert.equal(delivery.payload.id, id);
    assert.equal(delivery.payload.kind, 'message');
    assert.deepEqual(Object.keys(delivery.payload).sort(), ['expiresAt', 'id', 'kind']);
    assert.equal(delivery.wire.headers['Content-Encoding'], 'aes128gcm');
    assert.match(delivery.wire.headers.Authorization, /^vapid /);
    assert.equal((await pushRequest(outside, '/target/' + id)).status, 404);
    assert.deepEqual(await (await pushRequest(bob, '/target/' + id)).json(),
      { room: 'engineering', name: 'Bob', peerId: alice.guestId });
    await request(alice.socket, 'message:delete', { peerId: bob.guestId, messageId: id });
    assert.equal((await pushRequest(bob, '/target/' + id)).status, 404);

    assert.equal((await pushRequest(bob, '/subscription', 'DELETE', { endpoint: subscription.endpoint })).status, 204);
    await send('Opted out');
    assert.deepEqual(await (await pushRequest(bob, '/subscription', 'PATCH', { endpoint: subscription.endpoint })).json(),
      { enabled: false });
    assert.equal(deliveries.length, 1);
  });

  it('keeps an incoming call answerable after the recipient closes the tab', async () => {
    const deliveries = [];
    await server.close();
    await startServer(':memory:', { sendPush: async (subscription, payload, options) => {
      deliveries.push({ payload: JSON.parse(payload), options });
    } });
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const outside = await guest('Charlie', 'Engineering');
    const subscription = pushSubscription('https://web.push.apple.com/test-registration');
    assert.equal((await pushRequest(bob, '/subscription', 'PUT', subscription)).status, 204);
    await request(bob.socket, 'push:visibility', { foreground: true });
    const incoming = once(bob.socket, 'call:incoming');
    const { id } = await request(alice.socket, 'call:start', { peerId: bob.guestId, mode: 'video' });
    assert.equal((await incoming)[0].id, id);
    assert.equal(deliveries.length, 0);
    const left = once(alice.socket, 'updateUserList');
    bob.socket.disconnect();
    await left;
    await waitForPush(deliveries, 1);
    assert.equal(deliveries[0].payload.kind, 'call');
    assert.equal(deliveries[0].payload.id, id);
    assert.equal(deliveries[0].options.urgency, 'high');
    assert.ok(deliveries[0].options.TTL > 0 && deliveries[0].options.TTL <= 45);
    assert.equal((await pushRequest(outside, '/target/' + id)).status, 404);
    assert.deepEqual(await (await pushRequest(bob, '/target/' + id)).json(),
      { room: 'Engineering', name: 'Bob', peerId: alice.guestId });

    const returning = await connect(bob.cookie);
    await request(returning.socket, 'join', { name: 'Bob', room: 'Design' });
    await assert.rejects(request(returning.socket, 'call:accept', { id }), /no longer ringing/);
    const offer = once(returning.socket, 'call:incoming');
    await request(returning.socket, 'room:switch', { room: 'Engineering' });
    assert.equal((await offer)[0].id, id);
    const accepted = once(alice.socket, 'call:accepted');
    await request(returning.socket, 'call:accept', { id });
    assert.equal((await accepted)[0].id, id);
    await request(alice.socket, 'call:end', { id });
    assert.equal(deliveries.length, 1);
    assert.equal((await pushRequest(bob, '/target/' + id)).status, 200);

    await request(returning.socket, 'presence:update', { status: 'dnd' });
    const departed = once(alice.socket, 'updateUserList');
    returning.socket.disconnect();
    await departed;
    await assert.rejects(request(alice.socket, 'call:start', { peerId: bob.guestId, mode: 'video' }), /unavailable/);
  });

  it('persists the Web Push key and retries queued notifications after restart', async function () {
    this.timeout(8000);
    const database = path.join(dataDir, 'push-restart.sqlite');
    const first = [];
    await server.close();
    await startServer(database, { sendPush: async (subscription, payload) => {
      first.push(JSON.parse(payload));
      throw Object.assign(new Error('Temporary provider failure'), { statusCode: 503 });
    } });
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const subscription = pushSubscription('https://updates.push.services.mozilla.com/wpush/v2/test-registration');
    assert.equal((await pushRequest(bob, '/subscription', 'PUT', subscription)).status, 204);
    const { publicKey } = await (await pushRequest(bob)).json();
    const { id } = await request(alice.socket, 'dm:send', { peerId: bob.guestId, text: 'Queued during outage' });
    await waitForPush(first, 1);
    alice.socket.disconnect();
    bob.socket.disconnect();
    await server.close();
    const delivered = [];
    await startServer(database, { sendPush: async (endpoint, payload) => { delivered.push(JSON.parse(payload)); } });
    assert.deepEqual(await (await pushRequest(bob)).json(), { publicKey });
    await waitForPush(delivered, 1);
    assert.equal(delivered[0].id, id);
  });

  it('indexes existing direct history once and keeps read receipts across storage restarts', () => {
    const database = path.join(dataDir, 'direct-upgrade.sqlite');
    const alice = { guestId: '00000000-0000-0000-0000-000000000001', name: 'Alice', room: 'Engineering' };
    const bob = { guestId: '00000000-0000-0000-0000-000000000002', name: 'Bob', room: 'Engineering' };
    const key = directConversation(alice, bob);
    const initial = new MessageStore(50, database);
    const saved = initial.addMessage(key, { ...generateMessage(alice.name, 'Existing history'), authorId: alice.guestId });
    initial.db.exec("DROP TABLE direct_reads; DROP TABLE direct_threads; DELETE FROM settings WHERE name = 'direct_threads_v1';");
    initial.close();

    const upgraded = new MessageStore(50, database);
    assert.deepEqual(upgraded.getDirectThreads(bob)[0].peer, { guestId: alice.guestId, name: 'Alice' });
    assert.equal(upgraded.getDirectPage(key).messages[0].id, saved.id);
    const [receipt] = upgraded.markDirectRead(key, alice.guestId, [saved.id]).receipts;
    upgraded.close();

    const restarted = new MessageStore(50, database);
    try {
      assert.equal(restarted.getDirectThreads(bob)[0].unread, 0);
      assert.equal(restarted.getDirectPage(key).messages[0].readAt, receipt.readAt);
    } finally {
      restarted.close();
    }
  });

  it('keeps group and direct reply targets scoped to the original conversation', async () => {
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const outsider = await guest('Charlie', 'Engineering');
    const { id: groupId } = await request(alice.socket, 'createMessage', { text: 'Group topic' });
    const { id: privateId } = await request(alice.socket, 'dm:send', { peerId: bob.guestId, text: 'Private topic' });
    await assert.rejects(request(bob.socket, 'createMessage', { text: 'Wrong room', replyTo: privateId }), /unavailable/);
    await assert.rejects(request(bob.socket, 'dm:send', { peerId: alice.guestId, text: 'Wrong scope', replyTo: groupId }), /unavailable/);
    await assert.rejects(request(outsider.socket, 'dm:send', { peerId: alice.guestId, text: 'Wrong peer', replyTo: privateId }), /unavailable/);

    const groupReply = once(alice.socket, 'newMessage');
    await request(bob.socket, 'createMessage', { text: 'Group answer', replyTo: groupId });
    assert.deepEqual((await groupReply)[0].reply, { from: 'Alice', text: 'Group topic' });
    const privateReply = once(alice.socket, 'dm:message');
    await request(bob.socket, 'dm:send', { peerId: alice.guestId, text: 'Private answer', replyTo: privateId });
    assert.deepEqual((await privateReply)[0].message.reply, { from: 'Alice', text: 'Private topic' });
    assert.deepEqual((await request(bob.socket, 'dm:history', { peerId: alice.guestId })).messages.at(-1).reply,
      { from: 'Alice', text: 'Private topic' });

    const locationReply = once(alice.socket, 'dm:message');
    await request(bob.socket, 'dm:location', { peerId: alice.guestId, latitude: 23.81, longitude: 90.41, replyTo: privateId });
    assert.deepEqual((await locationReply)[0].message.reply, { from: 'Alice', text: 'Private topic' });
    assert.equal((await upload(outsider, 'Wrong peer', alice, privateId)).status, 409);
    const fileReply = once(alice.socket, 'dm:message');
    assert.equal((await upload(bob, 'Attachment reply', alice, privateId)).status, 201);
    assert.deepEqual((await fileReply)[0].message.reply, { from: 'Alice', text: 'Private topic' });
  });

  it('applies private edits, reactions and deletions only to the participants and their retained quotes', async () => {
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const outside = await guest('Charlie', 'Engineering');
    const observed = [];
    for (const event of ['message:edited', 'message:reaction-updated', 'message:deleted']) {
      outside.socket.on(event, (data) => observed.push(data));
    }
    const { id } = await request(alice.socket, 'dm:send', { peerId: bob.guestId, text: 'Original' });
    const { id: replyId } = await request(bob.socket, 'dm:send', { peerId: alice.guestId, text: 'Reply', replyTo: id });
    await assert.rejects(request(bob.socket, 'message:edit', { peerId: alice.guestId, messageId: id, text: 'Forgery' }), /Unable to edit/);
    await assert.rejects(request(outside.socket, 'message:reaction', { peerId: alice.guestId, messageId: id, emoji: '👍' }), /Unable to update/);
    await assert.rejects(request(outside.socket, 'message:delete', { messageId: id }), /Unable to delete/);
    const edited = once(bob.socket, 'message:edited');
    await request(alice.socket, 'message:edit', { peerId: bob.guestId, messageId: id, text: 'Changed' });
    assert.deepEqual((await edited)[0].quote, { from: 'Alice', text: 'Changed' });
    const reacted = once(alice.socket, 'message:reaction-updated');
    await request(bob.socket, 'message:reaction', { peerId: alice.guestId, messageId: id, emoji: '👍' });
    assert.equal((await reacted)[0].reactions['👍'][0].name, 'Bob');
    const history = async () => (await request(bob.socket, 'dm:history', { peerId: alice.guestId })).messages;
    assert.deepEqual((await history())[1].reply, { from: 'Alice', text: 'Changed' });
    const deleted = once(bob.socket, 'message:deleted');
    await request(alice.socket, 'message:delete', { peerId: bob.guestId, messageId: id });
    assert.equal((await deleted)[0].messageId, id);
    assert.deepEqual((await history()).map(({ id, reply }) => ({ id, reply })), [{ id: replyId, reply: null }]);
    await request(outside.socket, 'dm:history', { peerId: alice.guestId });
    assert.deepEqual(observed, []);
  });

  it('records unanswered calls in both timelines and lets the recipient call back', async () => {
    const alice = await guest('Alice', 'Engineering');
    const bob = await guest('Bob', 'Engineering');
    const missed = once(bob.socket, 'dm:message');
    const { id } = await request(alice.socket, 'call:start', { peerId: bob.guestId, mode: 'audio' });
    await request(alice.socket, 'call:end', { id });
    const [{ message }] = await missed;
    assert.equal(message.type, 'call');
    assert.equal(message.reason, 'cancelled');
    assert.equal(message.wasAnswered, false);
    assert.deepEqual((await request(alice.socket, 'dm:history', { peerId: bob.guestId })).messages, [message]);
    const callback = once(alice.socket, 'call:incoming');
    const next = await request(bob.socket, 'call:start', { peerId: alice.guestId, mode: message.mode });
    assert.notEqual(next.id, id);
    assert.equal((await callback)[0].mode, 'audio');
    await request(alice.socket, 'call:end', { id: next.id, reason: 'declined' });
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
    await assert.rejects(request(alice.socket, 'call:start', { peerId: bob.guestId, mode: 'video' }), /unavailable/);
    await request(bob.socket, 'presence:update', { status: 'online' });

    const incoming = once(bob.socket, 'call:incoming');
    const { id } = await request(alice.socket, 'call:start', { peerId: bob.guestId, mode: 'video' });
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
