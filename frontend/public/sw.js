/* Service worker — handles web push notifications for Darios Operations Portal */

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  const title   = data.title || "Dario's Landscaping";
  const options = {
    body:    data.body  || 'Tap to open the app.',
    icon:    '/darios-logo.png',
    badge:   '/darios-logo.png',
    vibrate: [200, 100, 200],
    data:    { url: data.url || '/field/documents' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/field/documents';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        for (const client of list) {
          if ('focus' in client) return client.focus();
        }
        return clients.openWindow(url);
      })
  );
});
