const CACHE_NAME = 'jotihunt-amalgama-v3';

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

    // Laat API calls, proxies en Firebase ALTIJD rechtstreeks via het netwerk lopen
    if (
        url.includes('jotihunt.nl') ||
        url.includes('allorigins.win') ||
        url.includes('corsproxy.io') ||
        url.includes('codetabs.com') ||
        url.includes('firebaseio.com') ||
        url.includes('firebasedatabase.app')
    ) {
        event.respondWith(
            fetch(event.request).catch(function(err) {
                // Vang netwerkfouten netjes op zonder dat de service worker crasht
                return new Response(JSON.stringify({ error: "Netwerkfout of geblokkeerd" }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
        return;
    }

    // Voor overige bestanden: eerst netwerk proberen, bij offline terugvallen op cache
    event.respondWith(
        fetch(event.request).catch(function() {
            return caches.match(event.request);
        })
    );
});

// Zorgt dat tikken op een melding op de telefoon de app naar voren haalt
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