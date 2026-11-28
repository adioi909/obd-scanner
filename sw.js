/* Network-first service worker: always tries for the latest version, falls back to cache offline (e.g. in a shop with no signal).
   v1.7.0: only the app shell is precached. Docs and build artifacts (MANUAL.md, PDFs, GROK_BUILD_BRIEF.md, zips) are never
   precached and never runtime-cached, so updates stay small on mobile data. manual.html (Help) is tiny and is precached;
   it loads MANUAL.md on demand when opened online. */
var CACHE = 'obd-scanner-v1.7.2';
var ASSETS = ['./', 'index.html', 'css/app.css', 'js/elm.js', 'js/pids.js', 'js/dtc.js', 'js/transport.js', 'js/probe.js', 'js/obd.js', 'js/storage.js', 'js/chart.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon.svg', 'manual.html'];
var NO_CACHE = /(\.pdf|\.zip|\.md)$|GROK_BUILD_BRIEF/i;
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (NO_CACHE.test(url.pathname)) return; // straight to the network, never stored
  e.respondWith(fetch(e.request).then(function (r) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); return r; })
    .catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
