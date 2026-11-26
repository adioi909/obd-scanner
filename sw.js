/* Network-first service worker: always tries for the latest version, falls back to cache offline (e.g. in a shop with no signal). */
var CACHE = 'obd-scanner-v1.1';
var ASSETS = ['./', 'index.html', 'css/app.css', 'js/elm.js', 'js/pids.js', 'js/dtc.js', 'js/transport.js', 'js/obd.js', 'js/storage.js', 'js/chart.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon.svg'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (r) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); return r; })
    .catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
