'use strict';

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const notices = {
  message: { title: 'New direct message', body: 'Open NexusChat to view the message.' },
  call: { title: 'Incoming call', body: 'Open NexusChat to answer.' },
  'group-audio-call': { title: 'Incoming group audio call', body: 'Open NexusChat to join the call.' },
  'group-video-call': { title: 'Incoming group video call', body: 'Open NexusChat to join the call.' },
};

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    if (!event.data) return;
    const { kind, id, expiresAt } = event.data.json();
    if (!idPattern.test(id) || !Object.hasOwn(notices, kind) ||
        !Number.isFinite(expiresAt) || Date.now() >= expiresAt) return;
    const { title, body } = notices[kind];
    await self.registration.showNotification(title, {
      body,
      icon: '/icons/nexus-192.png',
      tag: kind + ':' + id,
      data: { id },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data?.id;
  if (!idPattern.test(id)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const chat = windows.find((client) => new URL(client.url).pathname === '/chat.html');
    if (chat) {
      await chat.focus();
      chat.postMessage({ notificationId: id });
    } else {
      await self.clients.openWindow('/chat.html?notification=' + id);
    }
  })());
});
