import { api, appBase } from './api';

export type NotificationState = 'on' | 'off' | 'unsupported' | 'denied';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Where a tapped notification should land. Behind AI Server the app lives in
 * an iframe of the entry page, so open the entry page on this machine's tab
 * with the session (`/_hub/#/<machine>/<service>~/?s=<id>`); on its own, open
 * the app itself.
 */
function openUrl(): string {
  const mounted = appBase.pathname.match(/^\/_m\/([\w-]+)\/([\w-]+)\/$/);
  if (mounted) return `${location.origin}/_hub/#/${mounted[1]}/${mounted[2]}~/?s=`;
  return `${appBase.href}?s=`;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(appBase.href);
  if (existing) return existing;
  return navigator.serviceWorker.register(new URL('sw.js', appBase), { scope: appBase.pathname });
}

export async function notificationState(): Promise<NotificationState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await navigator.serviceWorker.getRegistration(appBase.href);
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

export async function enableNotifications(): Promise<NotificationState> {
  if (!supported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const key = await api.pushKey();
  if (!key) throw new Error('This machine has no push key');
  const subscription = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await api.subscribePush(subscription.toJSON(), openUrl());
  return 'on';
}

export async function disableNotifications(): Promise<NotificationState> {
  const reg = await navigator.serviceWorker.getRegistration(appBase.href);
  const subscription = await reg?.pushManager.getSubscription();
  if (subscription) {
    await api.unsubscribePush(subscription.endpoint).catch(() => undefined);
    await subscription.unsubscribe();
  }
  return 'off';
}

/** Messages from the service worker: a tapped notification asks the open page to show a session. */
export function onNotificationOpen(open: (sessionId: string) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const handler = (event: MessageEvent) => {
    const data = event.data as { type?: string; sessionId?: string } | undefined;
    if (data?.type === 'open-session' && data.sessionId) open(data.sessionId);
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
