/**
 * Web-push helpers — register the service worker, ask permission, subscribe, and save the
 * subscription to the backend (stamped with the signed-in user so task pushes can target them).
 */
import { getVapidPublicKey, savePushSubscription } from './api';

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'default' | 'unconfigured';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Current state without prompting — for showing the right button label. */
export async function currentPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub && Notification.permission === 'granted') return 'subscribed';
  } catch { /* ignore */ }
  return 'default';
}

/** Register the SW, request permission, subscribe, and save it. Returns the resulting state. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  let key: string;
  try {
    key = await getVapidPublicKey();
  } catch {
    return 'unconfigured';   // VAPID not set on the server yet
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'default';
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await savePushSubscription({
    endpoint: json.endpoint || '',
    p256dh: json.keys?.p256dh || '',
    auth: json.keys?.auth || '',
  });
  return 'subscribed';
}
