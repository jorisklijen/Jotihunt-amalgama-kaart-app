self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('fetch', function(e) {
  // Laat data en realtime requests direct door naar het netwerk
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
