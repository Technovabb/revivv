/* Revivv — service worker
 *
 * Two rules, and they matter:
 *
 *   1. The SHELL (the page, the logo, the fonts) is cached, so Revivv opens
 *      instantly and works with no signal.
 *
 *   2. Anything from Supabase is NEVER cached. Availability and stamp counts
 *      must be true right now, not true last Tuesday. A cached calendar
 *      would happily sell someone a slot that's already gone.
 */

const VERSION = 'revivv-v3';        // bump this when you change index.html
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './images/app-192.png',
  './images/app-512.png',
  './images/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())      // new version takes over immediately
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== VERSION).map(k => caches.delete(k))   // bin old versions
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never touch the database or the auth calls. Straight to the network, always.
  if (url.includes('supabase.co') || e.request.method !== 'GET') return;

  // Network first, cache as the safety net. So a customer with signal always
  // sees the current site; a customer in a car park with no bars still sees
  // something rather than a dinosaur.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
