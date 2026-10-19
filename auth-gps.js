/* ==========================================================================
   2. AUTH-GPS.JS - INLOGSYSTEEM, WAKELOCK, GPS TRACKING & LAZY LOADING
   ========================================================================== */

// Toon naamveld alleen bij hunter-pincode '1111'
document.getElementById('pin-input').addEventListener('input', function() {
    var val = this.value.trim();
    var nameField = document.getElementById('username-input');
    if (val === "1111") {
        nameField.style.display = 'inline-block';
        nameField.placeholder = 'Naam';
        nameField.focus();
    } else if (val === "6546") {
        nameField.style.display = 'none';
    }
});

document.getElementById('pin-input').addEventListener('keypress', function(e) { if (e.key === 'Enter') checkPin(); });
document.getElementById('username-input').addEventListener('keypress', function(e) { if (e.key === 'Enter') checkPin(); });

function checkPin() {
    var pin = document.getElementById('pin-input').value.trim();
    var name = document.getElementById('username-input').value.trim();
    var errorDiv = document.getElementById('auth-error');

    if (pin === "1111") { // Hunter login
        if (!name) {
            errorDiv.innerText = "Voer a.u.b. je naam in.";
            errorDiv.style.display = 'block';
            document.getElementById('username-input').focus();
            return;
        }
        isAdmin = false;
        currentUserName = name;
        setupUserIdentity();
        localStorage.setItem('jh_auth_role', 'user');
        localStorage.setItem('jh_auth_name', name);
        initApp();
    } else if (pin === "6546") { // Admin login
        isAdmin = true;
        currentUserName = "Admin";
        localStorage.setItem('jh_auth_role', 'admin');
        localStorage.setItem('jh_auth_name', 'Admin');
        initApp();
    } else {
        errorDiv.innerText = "Onjuiste pincode";
        errorDiv.style.display = 'block';
        document.getElementById('pin-input').value = '';
    }
}

function setupUserIdentity() {
    currentUserId = localStorage.getItem('jh_user_id');
    if (!currentUserId) {
        currentUserId = 'hunter_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('jh_user_id', currentUserId);
    }
}

function logout() {
    localStorage.removeItem('jh_auth_role');
    localStorage.removeItem('jh_auth_name');
    if (currentUserId) { db.ref('liveUsers/' + currentUserId).remove(); }
    stopLiveTracking();
    location.reload();
}

// Automatisch inloggen indien sessie bekend is
window.addEventListener('load', function() {
    var savedRole = localStorage.getItem('jh_auth_role');
    var savedName = localStorage.getItem('jh_auth_name');
    if (savedRole === 'admin') {
        isAdmin = true;
        currentUserName = "Admin";
        initApp();
    } else if (savedRole === 'user' && savedName) {
        isAdmin = false;
        currentUserName = savedName;
        setupUserIdentity();
        initApp();
    }
});

/* Lazy Loader: Laadt externe scripts en Admin-engine ALLEEN in voor de Admin */
function loadScript(src) {
    return new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function loadAdminDependencies() {
    // Voeg Leaflet Draw CSS toe
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css';
    document.head.appendChild(link);

    // Laad Proj4js, Leaflet Draw en vervolgens admin-engine.js
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js');
    await loadScript('admin-engine.js');

    if (typeof window.initAdminEngine === 'function') {
        window.initAdminEngine();
    }
}

function initApp() {
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';

    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    var badge = document.getElementById('user-badge');
    if (isAdmin) {
        badge.innerText = "Beheerder (Admin)";
        document.getElementById('btn-add-rd').style.display = 'inline-block';
        document.getElementById('clear-rd-btn').style.display = 'inline-block';
        loadAdminDependencies().catch(function(err) {
            console.error("Fout bij laden admin-modules:", err);
        });
    } else {
        badge.innerText = "Hunter: " + currentUserName;
        startBackgroundLiveTracking();
    }

    keepScreenAwake();

    setTimeout(function() {
        map.invalidateSize();
    }, 100);
}

/* --- SCREEN WAKE LOCK --- */
var wakeLock = null;
async function keepScreenAwake() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', function() {
                setTimeout(keepScreenAwake, 2000);
            });
        }
    } catch (err) {}
}
document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === 'visible') {
        keepScreenAwake();
    }
});

/* --- GPS & LIVE TRACKING VOOR HUNTERS --- */
var intervalTimer = null;
var workerTimer = null;

function sendCurrentLocation() {
    if (!navigator.geolocation || !currentUserId) return;
    navigator.geolocation.getCurrentPosition(function(pos) {
        var lat = pos.coords.latitude;
        var lng = pos.coords.longitude;
        var accuracy = pos.coords.accuracy || 0;

        db.ref('liveUsers/' + currentUserId).set({
            name: currentUserName,
            lat: lat,
            lng: lng,
            accuracy: Math.round(accuracy),
            lastSeen: Date.now()
        });
    }, function(err) {
        console.warn("GPS fout:", err.message);
    }, {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 15000
    });
}

function startBackgroundLiveTracking() {
    sendCurrentLocation();
    if (intervalTimer) clearInterval(intervalTimer);
    intervalTimer = setInterval(sendCurrentLocation, 30000);

    try {
        var blob = new Blob(["setInterval(function() { postMessage('tick'); }, 30000);"], { type: "text/javascript" });
        workerTimer = new Worker(URL.createObjectURL(blob));
        workerTimer.onmessage = function() { sendCurrentLocation(); };
    } catch (e) {
        console.warn("Worker niet beschikbaar:", e);
    }
}

function stopLiveTracking() {
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    if (workerTimer) { workerTimer.terminate(); workerTimer = null; }
    if (wakeLock !== null) { wakeLock.release(); wakeLock = null; }
}