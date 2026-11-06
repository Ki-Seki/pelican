// Pelican's service worker: push notifications only, no caching, so the app
// is always the version the server has.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Allow and Deny, where the device shows buttons on a notification. */
const canAnswer = () => typeof Notification !== 'undefined' && (Notification.maxActions ?? 0) >= 2;

/**
 * Android's pop-up shows a notification's title and one line of its text beside the buttons, the
 * rest only once it is expanded: there a command gets them only when it fits that line.
 */
const onAndroid = () => /Android/.test(self.navigator?.userAgent ?? '') || self.navigator?.userAgentData?.platform === 'Android';

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Claude Code', body: event.data ? event.data.text() : '' };
  }
  // A request Claude waits on can be answered from here: yes or no to a tool it wants to use.
  const answer = typeof data.request === 'string' && typeof data.sessionId === 'string' && canAnswer()
    && (data.fitsOneLine === true || !onAndroid());
  event.waitUntil(
    self.registration.showNotification(data.title || 'Claude Code', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: 'icon-192.png',
      badge: 'badge-96.png',
      data: { url: data.url, sessionId: data.sessionId, ...(answer ? { request: data.request } : {}) },
      ...(answer ? { actions: [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }] } : {}),
    }),
  );
});

/** Shows the session: in an open page, or in a new one. */
async function open(url, sessionId) {
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
}

/**
 * Answers the request through the same route as the page, the same way: marked as Pelican's, from
 * Pelican's own origin, with the sign-in this browser has. A request answered already, here or
 * anywhere, is no longer pending, and the answer changes nothing (409). Whether it was taken, or
 * the request is gone; false when it could not be sent (signed out, out of reach).
 */
async function decide(sessionId, request, behavior) {
  const url = new URL(`api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(request)}`, self.registration.scope);
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Pelican': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ behavior }),
    });
    return response.ok || response.status === 409;
  } catch {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, sessionId, request } = event.notification.data || {};
  if ((event.action === 'allow' || event.action === 'deny') && sessionId && request) {
    // Answered from the lock screen; when that cannot be done, the session opens to answer it there.
    event.waitUntil(decide(sessionId, request, event.action).then((done) => (done ? undefined : open(url, sessionId))));
    return;
  }
  event.waitUntil(open(url, sessionId));
});
