/* ==========================================================================
   2. AUTH-GPS.JS - FIREBASE INLOGSYSTEEM, WAKELOCK, GPS TRACKING & LAZY LOADING
   ========================================================================== */

var isSessionActive = false;

/* Luister real-time naar de wachtwoorden en sessie-versie in Firebase ('authSettings') */
db.ref('authSettings').on('value', function(snapshot) {
    var val = snapshot.val();
    var setupHint = document.getElementById('auth-setup-hint');

    if (!val || !val.adminPassword) {
        firebaseAuthConfig.adminPassword = null;
        firebaseAuthConfig.userPassword = (val && val.userPassword) ? String(val.userPassword) : "1111";
        firebaseAuthConfig.userSessionVersion = (val && val.userSessionVersion) ? Number(val.userSessionVersion) : 1;
        firebaseAuthConfig.loaded = true;
        if (setupHint) setupHint.style.display = 'block';
    } else {
        firebaseAuthConfig.adminPassword = String(val.adminPassword);
        firebaseAuthConfig.userPassword = val.userPassword !== undefined ? String(val.userPassword) : "1111";
        firebaseAuthConfig.userSessionVersion = val.userSessionVersion ? Number(val.userSessionVersion) : 1;
        firebaseAuthConfig.loaded = true;
        if (setupHint) setupHint.style.display = 'none';
    }

    // Update het invoerveld in het Beheer Instellingen paneel als de Admin is ingelogd
    var adminUserPwdInput = document.getElementById('admin-user-password-input');
    if (adminUserPwdInput && document.activeElement !== adminUserPwdInput) {
        adminUserPwdInput.value = firebaseAuthConfig.userPassword || "";
    }

    // Controleer voor ingelogde normale gebruikers (hunters) of het standaardwachtwoord is gewijzigd
    var savedRole = localStorage.getItem('jh_auth_role');
    if (isSessionActive && savedRole === 'user' && !isAdmin) {
        var savedVersion = Number(localStorage.getItem('jh_user_session_version') || 0);
        var savedPwd = localStorage.getItem('jh_user_pwd_snapshot');

        if (
            (savedVersion && savedVersion !== firebaseAuthConfig.userSessionVersion) ||
            (savedPwd !== null && savedPwd !== firebaseAuthConfig.userPassword)
        ) {
            alert("Het gebruikerswachtwoord is gewijzigd door de beheerder. Je wordt nu automatisch uitgelogd.");
            logout();
        }
    }
});

// Toon naamveld zodra het ingevoerde wachtwoord overeenkomt met het gebruikerswachtwoord in Firebase
document.getElementById('pin-input').addEventListener('input', function() {
    var val = this.value.trim();
    var nameField = document.getElementById('username-input');
    var errorDiv = document.getElementById('auth-error');
    if (errorDiv) errorDiv.style.display = 'none';

    if (!firebaseAuthConfig.loaded || !firebaseAuthConfig.adminPassword) {
        // Eerste keer opstarten: eerste wachtwoord wordt voor Admin, dus geen hunter-naamveld nodig
        nameField.style.display = 'none';
        return;
    }

    if (val !== "" && val === firebaseAuthConfig.userPassword && val !== firebaseAuthConfig.adminPassword) {
        nameField.style.display = 'inline-block';
        nameField.placeholder = 'Naam';
    } else if (val === firebaseAuthConfig.adminPassword) {
        nameField.style.display = 'none';
    }
});

document.getElementById('pin-input').addEventListener('keypress', function(e) { if (e.key === 'Enter') checkPin(); });
document.getElementById('username-input').addEventListener('keypress', function(e) { if (e.key === 'Enter') checkPin(); });

async function checkPin() {
    var pinInputEl = document.getElementById('pin-input');
    var nameInputEl = document.getElementById('username-input');
    var pin = pinInputEl.value.trim();
    var name = nameInputEl.value.trim();
    var errorDiv = document.getElementById('auth-error');

    if (!pin) {
        errorDiv.innerText = "Voer een wachtwoord in.";
        errorDiv.style.display = 'block';
        return;
    }

    try {
        // Haal voor de zekerheid altijd de actuele waarde uit Firebase op
        var snapshot = await db.ref('authSettings').once('value');
        var authData = snapshot.val();

        // SITUATIE 1: Er staat nog GEEN wachtwoord in Firebase -> Eerste ingevoerde wachtwoord is voor de Admin!
        if (!authData || !authData.adminPassword) {
            var initialVersion = 1;
            var defaultUserPwd = (authData && authData.userPassword) ? String(authData.userPassword) : "1111";

            await db.ref('authSettings').set({
                adminPassword: pin,
                userPassword: defaultUserPwd,
                userSessionVersion: initialVersion,
                updatedAt: Date.now()
            });

            firebaseAuthConfig.adminPassword = pin;
            firebaseAuthConfig.userPassword = defaultUserPwd;
            firebaseAuthConfig.userSessionVersion = initialVersion;
            firebaseAuthConfig.loaded = true;

            isAdmin = true;
            currentUserName = "Admin";
            localStorage.setItem('jh_auth_role', 'admin');
            localStorage.setItem('jh_auth_name', 'Admin');
            localStorage.setItem('jh_admin_pwd_snapshot', pin);

            alert("✅ Nog geen wachtwoord gevonden in Firebase.\n\nJouw ingevoerde wachtwoord is nu ingesteld als het Admin-wachtwoord! Je kunt het wachtwoord voor de gebruikers instellen in het Beheer Instellingen menu.");
            initApp();
            return;
        }

        var currentAdminPwd = String(authData.adminPassword);
        var currentUserPwd = authData.userPassword !== undefined ? String(authData.userPassword) : "1111";
        var currentVersion = authData.userSessionVersion ? Number(authData.userSessionVersion) : 1;

        // SITUATIE 2: Ingevoerde wachtwoord klopt met het Admin-wachtwoord in Firebase
        if (pin === currentAdminPwd) {
            isAdmin = true;
            currentUserName = "Admin";
            localStorage.setItem('jh_auth_role', 'admin');
            localStorage.setItem('jh_auth_name', 'Admin');
            localStorage.setItem('jh_admin_pwd_snapshot', currentAdminPwd);
            initApp();
            return;
        }

        // SITUATIE 3: Ingevoerde wachtwoord klopt met het Gebruikerswachtwoord in Firebase
        if (pin === currentUserPwd) {
            if (nameInputEl.style.display === 'none') {
                nameInputEl.style.display = 'inline-block';
                nameInputEl.focus();
            }
            if (!name) {
                errorDiv.innerText = "Voer a.u.b. je naam in.";
                errorDiv.style.display = 'block';
                nameInputEl.focus();
                return;
            }
            isAdmin = false;
            currentUserName = name;
            setupUserIdentity();
            localStorage.setItem('jh_auth_role', 'user');
            localStorage.setItem('jh_auth_name', name);
            localStorage.setItem('jh_user_session_version', String(currentVersion));
            localStorage.setItem('jh_user_pwd_snapshot', currentUserPwd);
            initApp();
            return;
        }

        // Onjuist wachtwoord
        errorDiv.innerText = "Onjuist wachtwoord";
        errorDiv.style.display = 'block';
        pinInputEl.value = '';
    } catch (err) {
        console.error("Fout bij controleren wachtwoord in Firebase:", err);
        errorDiv.innerText = "Verbindingsfout met Firebase. Probeer opnieuw.";
        errorDiv.style.display = 'block';
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
    isSessionActive = false;
    localStorage.removeItem('jh_auth_role');
    localStorage.removeItem('jh_auth_name');
    localStorage.removeItem('jh_user_session_version');
    localStorage.removeItem('jh_user_pwd_snapshot');
    localStorage.removeItem('jh_admin_pwd_snapshot');
    if (currentUserId) { db.ref('liveUsers/' + currentUserId).remove(); }
    stopLiveTracking();
    location.reload();
}

// Automatisch inloggen indien sessie bekend én nog geldig is in Firebase
window.addEventListener('load', function() {
    var savedRole = localStorage.getItem('jh_auth_role');
    var savedName = localStorage.getItem('jh_auth_name');
    if (!savedRole) return;

    db.ref('authSettings').once('value').then(function(snapshot) {
        var authData = snapshot.val();
        if (!authData || !authData.adminPassword) {
            // Geen wachtwoord in Firebase -> verplicht naar inlogscherm om eerste admin-wachtwoord in te stellen
            localStorage.removeItem('jh_auth_role');
            localStorage.removeItem('jh_auth_name');
            return;
        }

        var currentAdminPwd = String(authData.adminPassword);
        var currentUserPwd = authData.userPassword !== undefined ? String(authData.userPassword) : "1111";
        var currentVersion = authData.userSessionVersion ? Number(authData.userSessionVersion) : 1;

        if (savedRole === 'admin') {
            var savedAdminPwd = localStorage.getItem('jh_admin_pwd_snapshot');
            if (savedAdminPwd && savedAdminPwd !== currentAdminPwd) {
                logout();
                return;
            }
            localStorage.setItem('jh_admin_pwd_snapshot', currentAdminPwd);
            isAdmin = true;
            currentUserName = "Admin";
            initApp();
        } else if (savedRole === 'user' && savedName) {
            var savedVersion = Number(localStorage.getItem('jh_user_session_version') || 0);
            var savedUserPwd = localStorage.getItem('jh_user_pwd_snapshot');

            // Als het gebruikerswachtwoord in de tussentijd is gewijzigd -> direct uitloggen!
            if (
                (savedVersion && savedVersion !== currentVersion) ||
                (savedUserPwd !== null && savedUserPwd !== currentUserPwd)
            ) {
                logout();
                return;
            }
            localStorage.setItem('jh_user_session_version', String(currentVersion));
            localStorage.setItem('jh_user_pwd_snapshot', currentUserPwd);
            isAdmin = false;
            currentUserName = savedName;
            setupUserIdentity();
            initApp();
        }
    });
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
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js');
    await loadScript('admin-engine.js');

    if (typeof window.initAdminEngine === 'function') {
        window.initAdminEngine();
    }
}

function initApp() {
    isSessionActive = true;
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
        if (!isAdmin && currentUserId) {
            sendCurrentLocation();
        }
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
    intervalTimer = setInterval(sendCurrentLocation, 15000);

    try {
        var blob = new Blob(["setInterval(function() { postMessage('tick'); }, 15000);"], { type: "text/javascript" });
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