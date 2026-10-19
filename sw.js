const CACHE_NAME = 'jotihunt-amalgama-v4';

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

    // Laat alle externe API calls, proxies en Firebase volledig met rust in de Service Worker
    if (
        url.includes('jotihunt.nl') ||
        url.includes('workers.dev') ||
        url.includes('allorigins.win') ||
        url.includes('corsproxy.io') ||
        url.includes('codetabs.com') ||
        url.includes('firebaseio.com') ||
        url.includes('firebasedatabase.app')
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