const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const worker = readFileSync(join(__dirname, '../public/service-worker.js'), 'utf8');

function setup(windows = []) {
  const handlers = new Map();
  const displayed = [];
  const opened = [];
  const self = {
    addEventListener: (name, handle) => handlers.set(name, handle),
    registration: { showNotification: async (title, options) => displayed.push({ title, options }) },
    clients: { matchAll: async () => windows, openWindow: async (url) => opened.push(url) },
  };
  runInNewContext(worker, { self, URL, Date });
  async function dispatch(name, payload) {
    let work;
    handlers.get(name)({ ...payload, waitUntil: (promise) => { work = promise; } });
    await work;
  }
  return { displayed, opened, dispatch };
}

describe('Web Push worker', () => {
  it('shows a private notification and opens the signed-session route after a closed tab', async () => {
    const { displayed, opened, dispatch } = setup();
    const id = randomUUID();
    await dispatch('push', { data: { json: () => ({ kind: 'message', id, expiresAt: Date.now() + 60000 }) } });
    assert.equal(displayed[0].title, 'New direct message');
    assert.equal(displayed[0].options.body, 'Open NexusChat to view the message.');
    let closed = false;
    await dispatch('notificationclick', { notification: {
      data: displayed[0].options.data,
      close: () => { closed = true; },
    } });
    assert.equal(closed, true);
    assert.deepEqual(opened, ['/chat.html?notification=' + id]);
  });

  it('focuses the existing chat and discards an expired call alert', async () => {
    const delivered = [];
    let focused = false;
    const { displayed, opened, dispatch } = setup([{
      url: 'https://chat.example/chat.html',
      focus: async () => { focused = true; },
      postMessage: (data) => delivered.push(data.notificationId),
    }]);
    const id = randomUUID();
    await dispatch('push', { data: { json: () => ({ kind: 'call', id, expiresAt: Date.now() - 1 }) } });
    assert.deepEqual(displayed, []);
    await dispatch('push', { data: { json: () => ({ kind: 'call', id, expiresAt: Date.now() + 45000 }) } });
    assert.equal(displayed[0].title, 'Incoming call');
    await dispatch('notificationclick', { notification: { data: displayed[0].options.data, close() {} } });
    assert.equal(focused, true);
    assert.deepEqual(delivered, [id]);
    assert.deepEqual(opened, []);
  });
});
