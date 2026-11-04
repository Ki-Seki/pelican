// Pelican's service worker: push notifications only, no caching, so the app
// is always the version the server has.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Claude Code', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Claude Code', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: 'icon-192.png',
      badge: 'badge-96.png',
      data: { url: data.url, sessionId: data.sessionId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, sessionId } = event.notification.data || {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // An open page shows the session itself, even when another page frames it.
    for (const client of windows) {
      if (sessionId) client.postMessage({ type: 'open-session', sessionId });
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    if (url) await self.clients.openWindow(url);
  })());
});
