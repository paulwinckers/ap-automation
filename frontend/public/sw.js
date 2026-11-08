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
    data:    { url: data.url || '/field/documents', claude_url: data.claude_url || null },
  };
  // Task notifications offer "Handle with Claude" (Android/desktop show action buttons; iPhone
  // shows the notification only — My Action Items has the same button).
  if (data.claude_url) {
    options.actions = [
      { action: 'claude', title: 'Handle with Claude' },
      { action: 'open',   title: 'Open' },
    ];
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/field/documents';

  if (event.action === 'claude' && event.notification.data?.claude_url) {
    event.waitUntil(clients.openWindow(event.notification.data.claude_url));
    return;
  }

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        for (const client of list) {
          // Reuse an open portal window, but take it to the notification's page.
          if ('focus' in client) {
            return ('navigate' in client ? client.navigate(url) : Promise.resolve(client))
              .then(c => (c || client).focus());
          }
        }
        return clients.openWindow(url);
      })
  );
});
