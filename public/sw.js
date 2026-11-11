/* Cartable service worker: makes the app installable, opens without a network,
   and shows notifications (new homework, marks, classes about to start). */
const CACHE = 'cartable-v2';
const SHELL = ['/', '/css/app.css', '/css/fonts.css', '/js/i18n.js', '/js/app.js', '/js/room.js', '/js/school.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// The app's own files: always try the network first (so updates arrive at once), and fall back
// to the last copy when offline. Class data, live classes and files are never cached.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/fonts/'))) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(async () => (await caches.match(e.request)) || (e.request.mode === 'navigate' ? caches.match('/') : Response.error())));
});

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(m.title || 'Cartable', {
    body: m.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: m.tag,
    renotify: !!m.tag,
    data: { url: m.url || '/#/today' },
  }));
});

// Open the page the notification is about, in an open Cartable window if there is one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((w) => new URL(w.url).origin === location.origin);
    if (win) return win.navigate(url).then((w) => (w || win).focus()).catch(() => win.focus());
    return self.clients.openWindow(url);
  }));
});
