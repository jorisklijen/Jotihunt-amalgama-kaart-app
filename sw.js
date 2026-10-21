const CACHE_NAME = 'jotihunt-amalgama-v10';

self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.map(function(cacheName) {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(function() {
            return self.clients.claim();
        })
    );
});

self.addEventListener('fetch', function(event) {
    const url = event.request.url;

    // Laat Firebase, Cloudflare Worker, PDOK/OSM adres-geocoding en OSRM wandelroutes buiten de Service Worker cache
    if (
        url.includes('firebaseio.com') ||
        url.includes('firebasedatabase.app') ||
        url.includes('workers.dev') ||
        url.includes('api.pdok.nl') ||
        url.includes('nominatim.openstreetmap.org') ||
        url.includes('routing.openstreetmap.de') ||
        url.includes('router.project-osrm.org')
    ) {
        return;
    }

    // Voor eigen bestanden: eerst netwerk proberen, bij offline terugvallen op cache
    event.respondWith(
        fetch(event.request).catch(function() {
            return caches.match(event.request);
        })
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            for (var i = 0; i < clientList.length; i++) {
                var client = clientList[i];
                if ('focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('./index.html');
            }
        })
    );
});