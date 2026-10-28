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

const VERSION = 'revivv-435f48b3';        // bump this when you change index.html
const SHELL = [
  './',
  './how.html',
  './index.html',
  './my-account.html',
  './my-booking.html',
  './my-bookings.html',
  './my-cars.html',
  './my-messages.html',
  './packages.html',
  './portal.html',
  './quote.html',
  './rewards.html',
  './staff-booking.html',
  './staff-bookings.html',
  './staff-customer.html',
  './staff-customers.html',
  './staff-messages.html',
  './staff-money.html',
  './staff-new.html',
  './staff-outbox.html',
  './staff-reports.html',
  './staff-settings.html',
  './staff-team.html',
  './staff.html',
  './work.html',
  './manifest.json',
  './assets/css/my.css',
  './assets/css/office.css',
  './assets/css/site.css',
  './assets/js/api.js',
  './assets/js/app.js',
  './assets/js/my-account.js',
  './assets/js/my-booking.js',
  './assets/js/my-bookings.js',
  './assets/js/my-cars.js',
  './assets/js/my-messages.js',
  './assets/js/my.js',
  './assets/js/office-booking.js',
  './assets/js/office-bookings.js',
  './assets/js/office-customer.js',
  './assets/js/office-customers.js',
  './assets/js/office-messages.js',
  './assets/js/office-money.js',
  './assets/js/office-new.js',
  './assets/js/office-outbox.js',
  './assets/js/office-reports.js',
  './assets/js/office-settings.js',
  './assets/js/office-team.js',
  './assets/js/office-today.js',
  './assets/js/office.js',
  './assets/js/portal.js',
  './assets/js/slider.js',
  './images/logo.png',
  './images/favicon.png',
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

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
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
