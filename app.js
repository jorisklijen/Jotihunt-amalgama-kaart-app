/* ==========================================================================
   SCOUTING AMALGAMA JOTIHUNT APP - MAIN LOGIC
   ========================================================================== */

/* --- 1. FIREBASE CONFIGURATIE & INITIALISATIE --- */
var firebaseConfig = {
    apiKey: "AIzaSyDHNhlTRR0yr-6d_wOkmld1cInPLlxVM2o",
    authDomain: "jotihunt-amalgama.firebaseapp.com",
    databaseURL: "https://jotihunt-amalgama-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "jotihunt-amalgama",
    storageBucket: "jotihunt-amalgama.firebasestorage.app",
    messagingSenderId: "718674003357",
    appId: "1:718674003357:web:83b77c3334b9ea010e5b74",
    measurementId: "G-YBXKZPR30J"
};

firebase.initializeApp(firebaseConfig);
var db = firebase.database();

/* Globale applicatie-variabelen voor authenticatie en status */
var isAdmin = false;
var currentUserName = "";
var currentUserId = "";

/* --- 2. AUTHENTICATIE & INLOGBEHEER --- */
function openJotihuntSite() { window.open('https://jotihunt.nl/', '_blank'); }
function dismissNotification(e) {
    e.stopPropagation();
    document.getElementById('notification-banner').style.display = 'none';
}

// Controleer pincode om invoerveld voor gebruikersnaam te tonen (bij pincode '1111')
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

// Automatisch inloggen indien sessie bekend is in localStorage
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

document.getElementById('pin-input').addEventListener('keypress', function (e) { if (e.key === 'Enter') checkPin(); });
document.getElementById('username-input').addEventListener('keypress', function (e) { if (e.key === 'Enter') checkPin(); });

function initApp() {
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';

    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    var badge = document.getElementById('user-badge');
    if (isAdmin) {
        badge.innerText = "Beheerder (Admin)";
        document.getElementById('btn-fetch-latest').style.display = 'inline-block';
        document.getElementById('btn-add-rd').style.display = 'inline-block';
        document.getElementById('clear-rd-btn').style.display = 'inline-block';
        setupDrawTools();
        syncJotihuntToFirebase(true);
    } else {
        badge.innerText = "Hunter: " + currentUserName;
        startBackgroundLiveTracking();
        setTimeout(function() {
            syncJotihuntToFirebase(false);
        }, 2500);
    }

    keepScreenAwake();

    setTimeout(function() {
        map.invalidateSize();
    }, 100);
}

/* --- 3. SCREEN WAKE LOCK (Scherm aanhouden) --- */
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

/* --- 4. GPS & LIVE TRACKING --- */
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
        maximumAge: 5000,
        timeout: 10000
    });
}

function startBackgroundLiveTracking() {
    sendCurrentLocation();
    if (intervalTimer) clearInterval(intervalTimer);
    intervalTimer = setInterval(sendCurrentLocation, 20000);

    try {
        var blob = new Blob(["setInterval(function() { postMessage('tick'); }, 20000);"], { type: "text/javascript" });
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

/* --- 5. WISKUNDE, GEOGRAFIE & COÖRDINATEN --- */
function getDistanceKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function getBearing(lat1, lon1, lat2, lon2) {
    var y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
    var x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
    var brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
}

function getDestinationLatLng(lat, lng, distMeters, bearingDeg) {
    var distRatio = distMeters / 6371000;
    var brngRad = bearingDeg * Math.PI / 180;
    var latRad = lat * Math.PI / 180;
    var lngRad = lng * Math.PI / 180;

    var endLat = Math.asin(Math.sin(latRad) * Math.cos(distRatio) +
                 Math.cos(latRad) * Math.sin(distRatio) * Math.cos(brngRad));
    var endLng = lngRad + Math.atan2(Math.sin(brngRad) * Math.sin(distRatio) * Math.cos(latRad),
                 Math.cos(distRatio) - Math.sin(latRad) * Math.sin(endLat));

    return [endLat * 180 / Math.PI, endLng * 180 / Math.PI];
}

function parseTimeToMinutes(timeStr) {
    if (!timeStr || !timeStr.includes(':')) return null;
    var p = timeStr.split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

/* --- 6. LEAFLET KAART INITIALISATIE & LAGEN --- */
proj4.defs("EPSG:28992", "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.387638888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.524,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs");
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

var targetAreas = ["Alpha", "Bravo", "Delta", "Foxtrot", "Golf", "Hotel", "Oscar"];
var areaColors = {
    "Alpha": "#e74c3c", "Bravo": "#f1c40f", "Delta": "#2ecc71",
    "Foxtrot": "#3498db", "Golf": "#ff69b4", "Hotel": "#e67e22", "Oscar": "#003399"
};

function parseTargetArea(input) {
    if (!input) return "";
    var cleanInput = input.trim().toLowerCase();
    return targetAreas.find(function(area) {
        return area.toLowerCase() === cleanInput;
    }) || "";
}

function parseCoordInput(coordInput) {
    var parts = coordInput.split(/[\s,;]+/);
    if (parts.length < 2) return null;

    var val1 = parseFloat(parts[0].replace(',', '.'));
    var val2 = parseFloat(parts[1].replace(',', '.'));
    if (isNaN(val1) || isNaN(val2)) return null;

    if (Math.abs(val1) <= 90 && Math.abs(val2) <= 180) {
        return [val1, val2];
    } else {
        var xStr = parts[0].replace(',', '.').split('.')[0];
        var yStr = parts[1].replace(',', '.').split('.')[0];
        while (xStr.length < 6) { xStr += "0"; }
        while (yStr.length < 6) { yStr += "0"; }
        var x = parseFloat(xStr);
        var y = parseFloat(yStr);
        try {
            var latLngArray = proj4("EPSG:28992", "EPSG:4326", [x, y]);
            return [latLngArray[1], latLngArray[0]];
        } catch (e) {
            console.error("Fout bij RD conversie:", e);
            return null;
        }
    }
}

var map = L.map('map').setView([51.9851, 5.8987], 10);

var lightTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri'
});

var darkBaseLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri'
});
var darkRefLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19
});
var darkLayerGroup = L.layerGroup([darkBaseLayer, darkRefLayer]);

var isDarkMode = localStorage.getItem('jh_map_theme') === 'dark';
var mapContainer = document.getElementById('map');
var vossenPanel = document.getElementById('vossen-status-panel');

function applyDarkMode(enabled) {
    if (enabled) {
        if (map.hasLayer(lightTileLayer)) map.removeLayer(lightTileLayer);
        if (!map.hasLayer(darkLayerGroup)) darkLayerGroup.addTo(map);
        mapContainer.classList.add('dark-mode-map');
        vossenPanel.classList.add('dark-mode-map-panel');
        document.getElementById('btn-darkmode').innerText = "☀️ Light";
        localStorage.setItem('jh_map_theme', 'dark');
    } else {
        if (map.hasLayer(darkLayerGroup)) map.removeLayer(darkLayerGroup);
        if (!map.hasLayer(lightTileLayer)) lightTileLayer.addTo(map);
        mapContainer.classList.remove('dark-mode-map');
        vossenPanel.classList.remove('dark-mode-map-panel');
        document.getElementById('btn-darkmode').innerText = "🌙 Dark";
        localStorage.setItem('jh_map_theme', 'light');
    }
}
applyDarkMode(isDarkMode);

function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    applyDarkMode(isDarkMode);
}

var fixedHouseLayer = new L.FeatureGroup().addTo(map);
var drawnItems = new L.FeatureGroup().addTo(map);
var rdPointsLayer = new L.FeatureGroup().addTo(map);
var rdRouteLayer = new L.FeatureGroup().addTo(map);
var usersLiveLayer = new L.FeatureGroup().addTo(map);
var geofenceLayer = new L.FeatureGroup().addTo(map);
var compassRoseLayer = new L.FeatureGroup();
var liveUserMarkers = {};
var cachedUsersData = {};

function updateUsersIsolationLabels() {
    var userIds = Object.keys(cachedUsersData);
    var isZoomedIn = map.getZoom() >= 12;

    userIds.forEach(function(uId) {
        var m = liveUserMarkers[uId];
        if (!m) return;
        var currentU = cachedUsersData[uId];
        if (!currentU || !currentU.lat || !currentU.lng) return;

        var minDistanceKm = Infinity;
        userIds.forEach(function(otherId) {
            if (otherId === uId) return;
            var otherU = cachedUsersData[otherId];
            if (!otherU || !otherU.lat || !otherU.lng) return;
            var dist = getDistanceKm(currentU.lat, currentU.lng, otherU.lat, otherU.lng);
            if (dist < minDistanceKm) { minDistanceKm = dist; }
        });

        var isIsolated = (userIds.length <= 1) || (minDistanceKm > 0.5);
        var tooltip = m.getTooltip();
        if (tooltip && tooltip._container) {
            if (!isZoomedIn && isIsolated) {
                tooltip._container.classList.add('user-label-always-show');
            } else {
                tooltip._container.classList.remove('user-label-always-show');
            }
        }
    });
}

function checkZoomLevel() {
    var mapContainer = document.getElementById('map');
    if (map.getZoom() >= 12) {
        mapContainer.classList.add('zoom-in-to-show');
        if (!map.hasLayer(geofenceLayer)) map.addLayer(geofenceLayer);
        if (!map.hasLayer(compassRoseLayer)) map.addLayer(compassRoseLayer);
    } else {
        mapContainer.classList.remove('zoom-in-to-show');
        if (map.hasLayer(geofenceLayer)) map.removeLayer(geofenceLayer);
        if (map.hasLayer(compassRoseLayer)) map.removeLayer(compassRoseLayer);
    }
    updateUsersIsolationLabels();
}
map.on('zoomend', checkZoomLevel);

/* --- 7. AMALGAMA CLUBGEBOUW & STRAAL --- */
var amalgamaLat = 51.83915;
var amalgamaLng = 5.78562;
var radiusMeters = 450;

L.circle([amalgamaLat, amalgamaLng], {
    radius: radiusMeters, color: '#e67e22', weight: 2, dashArray: '5, 5',
    fillColor: '#e67e22', fillOpacity: 0.12
}).addTo(map).bindTooltip("450m Straal Amalgama", { direction: 'top' });

var latOffset = radiusMeters / 111320; 
var lngOffset = radiusMeters / (111320 * Math.cos(amalgamaLat * (Math.PI / 180)));

[
    { label: 'N', lat: amalgamaLat + latOffset, lng: amalgamaLng },
    { label: 'Z', lat: amalgamaLat - latOffset, lng: amalgamaLng },
    { label: 'O', lat: amalgamaLat, lng: amalgamaLng + lngOffset },
    { label: 'W', lat: amalgamaLat, lng: amalgamaLng - lngOffset }
].forEach(function(dir) {
    var icon = L.divIcon({
        className: 'compass-icon-wrapper',
        html: `<div class="compass-label">${dir.label}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11]
    });
    L.marker([dir.lat, dir.lng], { icon: icon, interactive: false }).addTo(compassRoseLayer);
});

function setupDrawTools() {
    var drawControl = new L.Control.Draw({
        edit: { featureGroup: drawnItems, remove: true },
        draw: {
            polygon: false, rectangle: false, circle: false, circlemarker: false, marker: true,
            polyline: { shapeOptions: { color: '#000000', weight: 4, className: 'route-line' } }
        }
    });
    map.addControl(drawControl);
}

/* --- 8. CLUBGEBOUWEN DATA & BEZOCHT STATUS (Dynamisch via JSON) --- */
var allLocations = []; 
var houseVisitedStatus = {};

// Laad de clubgebouwen in vanuit clubs.json bij het opstarten
fetch('clubs.json')
    .then(function(response) { return response.json(); })
    .then(function(data) {
        allLocations = data;
        renderFixedHouses();
    })
    .catch(function(err) {
        console.warn("Kon clubs.json niet laden:", err);
    });

db.ref('houseVisited').on('value', function(snapshot) {
    houseVisitedStatus = snapshot.val() || {};
    renderFixedHouses();
});

window.toggleHouseVisited = function(houseName) {
    if (!isAdmin) return;
    var current = !!houseVisitedStatus[houseName];
    var newState = !current;
    
    var updates = {};
    updates[houseName.replace(/[.#$[\]]/g, '_')] = newState;
    db.ref('houseVisited').update(updates).then(function() {
        checkAreaRoundCompletion();
    });
};

function checkAreaRoundCompletion() {
    targetAreas.forEach(function(areaName) {
        var areaHouses = allLocations.filter(function(l) { return l.area === areaName; });
        if (areaHouses.length === 0) return;

        var allVisited = areaHouses.every(function(h) {
            var safeKey = h.name.replace(/[.#$[\]]/g, '_');
            return !!houseVisitedStatus[safeKey];
        });

        if (allVisited) {
            var resetUpdates = {};
            areaHouses.forEach(function(h) {
                var safeKey = h.name.replace(/[.#$[\]]/g, '_');
                resetUpdates[safeKey] = null;
            });
            db.ref('houseVisited').update(resetUpdates).then(function() {
                alert("🎉 Volledige ronde voltooid voor deelgebied " + areaName + "! Alle huisjes zijn weer op 'niet bezocht' gezet.");
            });
        }
    });
}

function renderFixedHouses() {
    fixedHouseLayer.clearLayers();

    if (!allLocations || allLocations.length === 0) return;

    allLocations.forEach(function(loc) {
        if (targetAreas.includes(loc.area)) {
            var areaColor = areaColors[loc.area] || "#3498db";
            var isOscar = (loc.area === "Oscar");
            var safeKey = loc.name.replace(/[.#$[\]]/g, '_');
            var isVisited = !!houseVisitedStatus[safeKey];
            var opacity = isVisited ? 0.5 : 1.0;

            var houseSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="${areaColor}" stroke="${isOscar ? "#003399" : "#000000"}" stroke-width="${isOscar ? 2 : 1}" style="opacity: ${opacity};" filter="drop-shadow(0px 2px 3px rgba(0,0,0,0.4))">
                <path d="M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/>
            </svg>`;

            var customIcon = L.divIcon({
                className: 'custom-house-pin', html: houseSvg,
                iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
            });

            var marker = L.marker([loc.lat, loc.lng], { icon: customIcon });
            marker.bindTooltip(loc.name + " (" + loc.area + ")", { permanent: true, direction: 'right', className: 'marker-label' });
            
            var visitedBtnHtml = '';
            if (isAdmin) {
                if (isVisited) {
                    visitedBtnHtml = `<button onclick="window.toggleHouseVisited('${loc.name.replace(/'/g, "\\'")}')" style="margin-top:6px; background:#e67e22; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">↩️ Zet op niet bezocht</button>`;
                } else {
                    visitedBtnHtml = `<button onclick="window.toggleHouseVisited('${loc.name.replace(/'/g, "\\'")}')" style="margin-top:6px; background:#27ae60; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">✔️ Markeer als bezocht</button>`;
                }
            }

            marker.bindPopup(`<b>${loc.name}</b><br>Deelgebied: ${loc.area}<br>Status: ${isVisited ? '<span style="color:#e67e22;">Bezocht</span>' : '<span style="color:#2ecc71;">Niet bezocht</span>'}<br><button onclick="window.navigateToAreaPoint(${loc.lat},${loc.lng})" style="margin-top:6px; background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">📍 Navigeer via Google Maps</button>${visitedBtnHtml}`);
            
            fixedHouseLayer.addLayer(marker);
        }
    });
}

/* --- 9. RD PUNTEN, GEOFENCES & BEREKENINGEN --- */
window.editRdPointPopup = function(key) {
    if (!isAdmin || !key) return;
    db.ref('rdPoints/' + key).once('value', function(snapshot) {
        var p = snapshot.val();
        if (!p) return;

        var newName = prompt("Bewerk naam van punt:", p.baseName || p.fullName || "Punt");
        if (newName === null) return;
        var newTime = prompt("Bewerk tijd (UU:MM):", p.time || "12:00");
        if (newTime === null) return;
        var currentCoordStr = p.latlng ? `${p.latlng[0].toFixed(5)}, ${p.latlng[1].toFixed(5)}` : "";
        var newCoordInput = prompt("Bewerk coördinaten (RD of Lat,Lng):", currentCoordStr);
        if (newCoordInput === null) return;

        var parsedLatLng = parseCoordInput(newCoordInput);
        if (!parsedLatLng) { alert("Ongeldige coördinaten!"); return; }

        var rawAreaInput = prompt("Deelgebied (Alpha, Bravo, Delta, Foxtrot, Golf, Hotel, Oscar):", p.area || "");
        if (rawAreaInput === null) return;

        var chosenArea = parseTargetArea(rawAreaInput);
        var markerColor = (chosenArea && areaColors[chosenArea]) ? areaColors[chosenArea] : "#000000";
        var areaSuffix = chosenArea ? " [" + chosenArea + "]" : "";

        db.ref('rdPoints/' + key).update({
            baseName: newName, fullName: newName + areaSuffix,
            time: newTime, latlng: parsedLatLng, area: chosenArea, color: markerColor
        }).then(function() { map.closePopup(); });
    });
};

window.deleteRdPointPopup = function(key) {
    if (!isAdmin || !key) return;
    if (confirm("Weet je zeker dat je dit RD-punt wilt verwijderen?")) {
        db.ref('rdPoints/' + key).remove().then(function() { map.closePopup(); });
    }
};

window.removeInactiveUser = function(userId, userName) {
    if (!isAdmin || !userId) return;
    if (confirm("Wil je inactieve gebruiker '" + userName + "' van de kaart halen?")) {
        db.ref('liveUsers/' + userId).remove().then(function() { map.closePopup(); });
    }
};

function createWalkerMarker(latlng, name, color, timeStr, opacity, extraInfo, isOscar = false, firebaseKey = null) {
    var strokeColor = isOscar ? "#003399" : "#000000";
    var walkerSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="${color}" stroke="${strokeColor}" stroke-width="${isOscar ? 2 : 1.5}" style="opacity: ${opacity};" filter="drop-shadow(0px 2px 3px rgba(0,0,0,0.4))">
        <path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.2L6 8.3V13h2V9.6l1.8-.7z"/>
    </svg>`;

    var customIcon = L.divIcon({
        className: 'custom-walker-pin', html: walkerSvg,
        iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15]
    });

    var labelText = name + " (" + timeStr + ")" + (extraInfo ? " • " + extraInfo : "");
    var marker = L.marker(latlng, { icon: customIcon });
    marker.bindTooltip(labelText, { permanent: true, direction: 'right', className: 'marker-label' });

    var popupContent = `<div style="font-size:12px; min-width:180px;">
        <b>${name}</b><br>
        <span>Tijd: <b>${timeStr}</b></span><br>
        ${extraInfo ? `<span>Snelheid: <b>${extraInfo}</b></span><br>` : ''}
        <button onclick="window.navigateToAreaPoint(${latlng[0]}, ${latlng[1]})" style="background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; width:100%; margin-top:6px; font-weight:bold;">
            📍 Navigeer naar dit punt
        </button>
        ${(isAdmin && firebaseKey) ? `
            <hr style="margin:6px 0; border:0; border-top:1px solid #4a627a;">
            <div style="display:flex; gap:5px; margin-top:4px;">
                <button onclick="window.editRdPointPopup('${firebaseKey}')" style="background:#f39c12; color:white; border:none; padding:4px 6px; border-radius:3px; cursor:pointer; font-weight:bold; flex:1;">✏️ Bewerk</button>
                <button onclick="window.deleteRdPointPopup('${firebaseKey}')" style="background:#e74c3c; color:white; border:none; padding:4px 6px; border-radius:3px; cursor:pointer; font-weight:bold; flex:1;">🗑️ Wis</button>
            </div>
        ` : ''}
    </div>`;
    marker.bindPopup(popupContent);
    return marker;
}

function createUserIcon(isActive) {
    var fillColor = isActive ? "#2ecc71" : "#7f8c8d";
    var strokeColor = isActive ? "#ffffff" : "#e74c3c";
    var strokeWidth = isActive ? 1.5 : 2;

    var userSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}" filter="drop-shadow(0px 2px 4px rgba(0,0,0,0.6))">
        <path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/>
    </svg>`;

    return L.divIcon({
        className: 'custom-car-pin', html: userSvg,
        iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16]
    });
}

var rdPointsByArea = { "Alpha": [], "Bravo": [], "Delta": [], "Foxtrot": [], "Golf": [], "Hotel": [], "Oscar": [] };
var latestKnownAreaPoints = {};

db.ref('rdPoints').on('value', function(snapshot) {
    for (var a in rdPointsByArea) rdPointsByArea[a] = [];
    latestKnownAreaPoints = {};

    var data = snapshot.val();
    if (data) {
        Object.keys(data).forEach(function(key) {
            var p = data[key];
            if (p && p.latlng && Array.isArray(p.latlng) && p.latlng.length === 2) {
                if (p.area && rdPointsByArea[p.area]) {
                    rdPointsByArea[p.area].push({
                        key: key, latlng: p.latlng, time: p.time || "12:00",
                        baseName: p.baseName || "Punt", fullName: p.fullName || p.baseName,
                        area: p.area, color: p.color || areaColors[p.area] || "#000000",
                        createdTimestamp: p.createdTimestamp || p.createdAt || Date.now()
                    });
                }
            }
        });
    }
    renderRdPointsAndGeofences();
});

function renderRdPointsAndGeofences() {
    rdPointsLayer.clearLayers();
    rdRouteLayer.clearLayers();
    geofenceLayer.clearLayers();

    var now = new Date();
    var currentTotalSeconds = (now.getHours() * 3600) + (now.getMinutes() * 60) + now.getSeconds();

    for (var area in rdPointsByArea) {
        var points = rdPointsByArea[area];
        if (points.length === 0) continue;

        points.sort(function(a, b) { return (a.time || "").localeCompare(b.time || ""); });
        var lastPoint = points[points.length - 1];

        var calculatedSpeedKmh = null;
        var speedText = "";
        var bearingDeg = null;
        var samplePoints = points.slice(-3);

        if (samplePoints.length >= 2) {
            var pFirst = samplePoints[0];
            var pLast = samplePoints[samplePoints.length - 1];
            var t1 = parseTimeToMinutes(pFirst.time);
            var t2 = parseTimeToMinutes(pLast.time);

            if (t1 !== null && t2 !== null && t2 > t1) {
                var totalDistKm = 0;
                for (var i = 0; i < samplePoints.length - 1; i++) {
                    totalDistKm += getDistanceKm(samplePoints[i].latlng[0], samplePoints[i].latlng[1],
                                                 samplePoints[i+1].latlng[0], samplePoints[i+1].latlng[1]);
                }
                var timeDiffHours = (t2 - t1) / 60;
                if (timeDiffHours > 0) {
                    var rawKmh = (totalDistKm / timeDiffHours);
                    calculatedSpeedKmh = Math.min(7.0, Math.max(0.5, rawKmh));
                    var displayKmh = Math.round(rawKmh * 10) / 10;
                    speedText = `~${displayKmh} km/u`;
                }
            }

            var sumSin = 0, sumCos = 0, totalWeight = 0;
            if (points.length >= 2) {
                var pA = points[points.length - 2];
                var pB = points[points.length - 1];
                var b1 = getBearing(pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1]) * Math.PI / 180;
                sumSin += 0.40 * Math.sin(b1); sumCos += 0.40 * Math.cos(b1); totalWeight += 0.40;
            }
            if (points.length >= 3) {
                var pA2 = points[points.length - 3];
                var pB2 = points[points.length - 2];
                var b2 = getBearing(pA2.latlng[0], pA2.latlng[1], pB2.latlng[0], pB2.latlng[1]) * Math.PI / 180;
                sumSin += 0.10 * Math.sin(b2); sumCos += 0.10 * Math.cos(b2); totalWeight += 0.10;
            }

            var areaHouses = allLocations.filter(function(l) { return l.area === area; });
            var unvisitedHouses = areaHouses.filter(function(h) {
                var safeKey = h.name.replace(/[.#$[\]]/g, '_');
                return !houseVisitedStatus[safeKey];
            });
            if (unvisitedHouses.length === 0) { unvisitedHouses = areaHouses; }

            if (unvisitedHouses.length > 0) {
                var nearestHouse = unvisitedHouses.reduce(function(prev, curr) {
                    var dPrev = getDistanceKm(lastPoint.latlng[0], lastPoint.latlng[1], prev.lat, prev.lng);
                    var dCurr = getDistanceKm(lastPoint.latlng[0], lastPoint.latlng[1], curr.lat, curr.lng);
                    return dCurr < dPrev ? curr : prev;
                });
                var bHouse = getBearing(lastPoint.latlng[0], lastPoint.latlng[1], nearestHouse.lat, nearestHouse.lng) * Math.PI / 180;
                sumSin += 0.40 * Math.sin(bHouse); sumCos += 0.40 * Math.cos(bHouse); totalWeight += 0.40;
            }

            if (totalWeight > 0) {
                var avgRad = Math.atan2(sumSin / totalWeight, sumCos / totalWeight);
                bearingDeg = ((avgRad * 180 / Math.PI) + 360) % 360;
            }
        }

        points.forEach(function(pt, idx) {
            var isLatest = (idx === points.length - 1);
            var isOscar = (pt.area === "Oscar");
            var ptMinutes = parseTimeToMinutes(pt.time);
            var diffMinutes = 0;
            if (ptMinutes !== null) {
                var currMin = Math.floor(currentTotalSeconds / 60);
                diffMinutes = currMin - ptMinutes;
            }

            var opacity = 1.0;
            if (diffMinutes > 60) {
                var fade = (diffMinutes - 60) / 180;
                opacity = Math.max(0.50, 1.0 - (fade * 0.50));
            }

            var extra = isLatest && speedText ? speedText : "";
            var marker = createWalkerMarker(pt.latlng, pt.fullName || pt.baseName, pt.color, pt.time, opacity, extra, isOscar, pt.key);
            rdPointsLayer.addLayer(marker);
            if (isLatest) { lastPoint.marker = marker; }
        });

        latestKnownAreaPoints[area] = lastPoint;

        if (points.length >= 2) {
            var latLngs = points.map(function(p) { return p.latlng; });
            var lineColor = (area === "Oscar") ? "#003399" : (areaColors[area] || "#000000");
            var polyline = L.polyline(latLngs, { color: lineColor, weight: 4, className: 'route-line' });
            polyline.bindPopup("<b>Chronologische route: " + area + "</b>");
            rdRouteLayer.addLayer(polyline);
        }

        var lastPtMinutes = parseTimeToMinutes(lastPoint.time);
        var isFuture = false;
        var secondsPassed = 0;

        if (lastPtMinutes !== null) {
            var pointSeconds = lastPtMinutes * 60;
            if (pointSeconds > currentTotalSeconds) { isFuture = true; } 
            else { secondsPassed = currentTotalSeconds - pointSeconds; }
        } else if (lastPoint.createdTimestamp) {
            var msDiff = Date.now() - lastPoint.createdTimestamp;
            if (msDiff < 0) { isFuture = true; } 
            else { secondsPassed = Math.floor(msDiff / 1000); }
        }

        var currentRadiusMeters = 1;
        if (!isFuture) {
            var effectiveSpeedKmh = calculatedSpeedKmh !== null ? calculatedSpeedKmh : 5.5;
            effectiveSpeedKmh = Math.min(7.0, effectiveSpeedKmh);
            var metersPerSecond = (effectiveSpeedKmh * 1000) / 3600;
            currentRadiusMeters = Math.max(1, Math.round(1 + (secondsPassed * metersPerSecond)));
        }

        var areaColor = areaColors[area] || "#e74c3c";
        var circle = L.circle(lastPoint.latlng, {
            radius: currentRadiusMeters, color: areaColor, weight: 2,
            dashArray: '6, 6', fillColor: areaColor, fillOpacity: 0.12, interactive: false
        });
        geofenceLayer.addLayer(circle);

        var badgeText = isFuture ? `🎯 ${area}: 1 m (in toekomst)` : `🎯 ${area}: ${currentRadiusMeters >= 1000 ? (currentRadiusMeters/1000).toFixed(1) + ' km' : currentRadiusMeters + ' m'}`;
        var badgeIcon = L.divIcon({
            className: 'geofence-badge-wrapper',
            html: `<div class="geofence-radius-badge" style="border-color:${areaColor};">${badgeText}</div>`,
            iconSize: [80, 20], iconAnchor: [40, 10]
        });
        geofenceLayer.addLayer(L.marker(lastPoint.latlng, { icon: badgeIcon, interactive: false }));

        if (bearingDeg !== null && !isFuture) {
            [-60, 60].forEach(function(offsetAngle) {
                var arrowAngle = (bearingDeg + offsetAngle + 360) % 360;
                var arrowEndCoord = getDestinationLatLng(lastPoint.latlng[0], lastPoint.latlng[1], currentRadiusMeters, arrowAngle);

                var arrowLine = L.polyline([lastPoint.latlng, arrowEndCoord], {
                    color: areaColor, weight: 2.5, dashArray: '4, 4', opacity: 0.85
                });
                geofenceLayer.addLayer(arrowLine);

                var tipSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" style="transform: rotate(${arrowAngle}deg);">
                    <polygon points="12,2 22,22 12,17 2,22" fill="${areaColor}" stroke="#ffffff" stroke-width="1.5"/>
                </svg>`;
                var tipIcon = L.divIcon({
                    className: 'arrow-tip-icon', html: tipSvg, iconSize: [20, 20], iconAnchor: [10, 10]
                });
                geofenceLayer.addLayer(L.marker(arrowEndCoord, { icon: tipIcon, interactive: false }));
            });
        }
    }
}
setInterval(renderRdPointsAndGeofences, 20000);

var isInitialRdLoad = true;
db.ref('rdPoints').once('value', function() { isInitialRdLoad = false; });

db.ref('rdPoints').on('child_added', function(snapshot) {
    if (isInitialRdLoad) return;
    var p = snapshot.val();
    if (!p) return;

    var now = Date.now();
    var itemTime = p.createdAt || p.createdTimestamp || now;
    var isRecent = (now - itemTime < 15 * 60 * 1000);

    if (isRecent) {
        var puntNaam = p.fullName || p.baseName || "Nieuw punt";
        var deelgebied = p.area ? " in " + p.area : "";
        var tijdTekst = p.time ? " (" + p.time + ")" : "";

        if ('vibrate' in navigator) { navigator.vibrate([300, 100, 300, 100, 300]); }

        if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
            navigator.serviceWorker.ready.then(function(reg) {
                reg.showNotification("🎯 Nieuw RD Punt" + deelgebied, {
                    body: puntNaam + tijdTekst + " geplaatst op de kaart!",
                    icon: 'icon-192.png', badge: 'icon-192.png',
                    vibrate: [300, 100, 300, 100, 300],
                    tag: 'rd-alert-' + snapshot.key, renotify: true
                });
            });
        }
    }
});

window.navigateToAreaPoint = function(lat, lng) {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
};

/* --- 10. LIVE GEBRUIKERS & HUNTERS OP DE KAART --- */
db.ref('liveUsers').on('value', function(snapshot) {
    var users = snapshot.val();
    var now = Date.now();

    if (!users) {
        cachedUsersData = {};
        usersLiveLayer.clearLayers();
        liveUserMarkers = {};
        return;
    }

    cachedUsersData = users;

    Object.keys(users).forEach(function(userId) {
        var u = users[userId];
        if (!u || !u.lat || !u.lng) return;

        var isActive = (now - (u.lastSeen || 0)) <= (3 * 60 * 1000);
        var minutesAgo = Math.floor((now - (u.lastSeen || 0)) / 60000);
        var timeAgoText = minutesAgo <= 0 ? "Zojuist" : minutesAgo + "m geleden";

        var icon = createUserIcon(isActive);
        var labelClass = isActive ? 'marker-label user-gps-label-active' : 'marker-label user-gps-label-inactive';
        var statusText = isActive ? '<span style="color:#2ecc71; font-weight:bold;">● Actief</span>' : '<span style="color:#e74c3c; font-weight:bold;">● Inactief</span>';

        var distAmalgama = getDistanceKm(u.lat, u.lng, amalgamaLat, amalgamaLng).toFixed(1);
        var etaAmalgama = Math.round((distAmalgama / 45) * 60);

        var vossenOptions = `<option value="${amalgamaLat},${amalgamaLng}">Clubgebouw (${distAmalgama} km - ~${etaAmalgama} min)</option>`;
        
        targetAreas.forEach(function(areaName) {
            if (latestKnownAreaPoints[areaName]) {
                var pt = latestKnownAreaPoints[areaName];
                var dist = getDistanceKm(u.lat, u.lng, pt.latlng[0], pt.latlng[1]).toFixed(1);
                var eta = Math.round((dist / 45) * 60);
                vossenOptions += `<option value="${pt.latlng[0]},${pt.latlng[1]}">🎯 Laatste RD: ${areaName} (${dist} km - ~${eta} min)</option>`;
            }
        });

        var safeUserName = (u.name || "Gebruiker").replace(/'/g, "\\'");
        var popupHtml = `
            <div style="font-size:12px; min-width:200px;">
                <b>🚗 ${u.name}</b><br>
                Status: ${statusText}<br>
                Nauwkeurigheid: ~${u.accuracy || '?'}m (${timeAgoText})<br>
                <hr style="margin:5px 0; border:0; border-top:1px solid #4a627a;">
                <b>Kies doel & navigeer:</b><br>
                <select id="sel_dest_${userId}" style="width:100%; padding:4px; margin-top:4px; font-size:11px;">
                    ${vossenOptions}
                </select>
                <button onclick="(function(){
                    var val = document.getElementById('sel_dest_${userId}').value.split(',');
                    window.navigateToAreaPoint(val[0], val[1]);
                })()" style="background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; width:100%; margin-top:6px; font-weight:bold;">
                    📍 Navigeer via Google Maps
                </button>
                ${(isAdmin && !isActive) ? `
                    <button onclick="window.removeInactiveUser('${userId}', '${safeUserName}')" style="background:#c0392b; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; width:100%; margin-top:6px; font-weight:bold;">
                        🗑️ Verberg inactieve gebruiker
                    </button>
                ` : ''}
            </div>
        `;

        if (liveUserMarkers[userId]) {
            liveUserMarkers[userId].setLatLng([u.lat, u.lng]);
            liveUserMarkers[userId].setIcon(icon);
            liveUserMarkers[userId].setTooltipContent("🚗 " + u.name);
            var tooltipEl = liveUserMarkers[userId].getTooltip();
            if (tooltipEl && tooltipEl._container) {
                tooltipEl._container.className = 'leaflet-tooltip leaflet-zoom-animated ' + labelClass;
            }
            liveUserMarkers[userId].getPopup().setContent(popupHtml);
        } else {
            var m = L.marker([u.lat, u.lng], { icon: icon });
            m.bindTooltip("🚗 " + u.name, { permanent: true, direction: 'top', className: labelClass });
            m.bindPopup(popupHtml);
            usersLiveLayer.addLayer(m);
            liveUserMarkers[userId] = m;
        }
    });

    Object.keys(liveUserMarkers).forEach(function(userId) {
        if (!users[userId]) {
            usersLiveLayer.removeLayer(liveUserMarkers[userId]);
            delete liveUserMarkers[userId];
        }
    });

    updateUsersIsolationLabels();
});

/* --- 11. ADMIN ACTIES & BEHEER --- */
function clearRdPoints() {
    if (!isAdmin) return;
    var pinInput = prompt("Voer de admin-pincode in om de RD-lijnen te wissen:", "");
    if (pinInput === "6546") {
        db.ref('rdPoints').remove().then(function() { alert("RD-punten succesvol gewist."); });
    } else if (pinInput !== null) { alert("Onjuiste pincode!"); }
}

function addMarkerByRD() {
    if (!isAdmin) return;
    var name = prompt("Voer een naam in voor dit punt:", "Punt");
    if (!name) return;

    var coordInput = prompt("Voer coördinaten in (RD of GPS):\nBijv: 1800, 4500  OF  51.9851, 5.8987", "1800, 4500");
    if (!coordInput) return;

    var latlng = parseCoordInput(coordInput);
    if (!latlng) { alert("Ongeldige coördinaten ingevoerd."); return; }

    var rawAreaInput = prompt("Koppel aan deelgebied (Alpha, Bravo, Delta, Foxtrot, Golf, Hotel, Oscar). Laat leeg:", "");
    var chosenArea = parseTargetArea(rawAreaInput);

    var markerColor = "#000000";
    var areaKey = "";
    var areaSuffix = "";

    if (chosenArea && areaColors[chosenArea]) {
        areaKey = chosenArea;
        markerColor = areaColors[areaKey];
        areaSuffix = " [" + areaKey + "]";
    }

    var now = new Date();
    var defaultTime = String(now.getHours()).padStart(2, '0') + ":" + String(now.getMinutes()).padStart(2, '0');
    var timeInput = prompt("Voer tijdstip in (UU:MM):", defaultTime) || defaultTime;

    db.ref('rdPoints').push({
        latlng: latlng, time: timeInput, baseName: name, area: areaKey,
        fullName: name + areaSuffix, color: markerColor, createdAt: Date.now(), createdTimestamp: Date.now()
    }).then(function() { map.setView(latlng, 14); });
}
checkZoomLevel();

/* --- 12. VOSSEN PANEEL SLEPEN & INTERACTIE --- */
var panel = document.getElementById('vossen-status-panel');
var header = document.getElementById('vossen-status-header');
var isDragging = false, startX, startY;

header.addEventListener('mousedown', function(e) {
    if (e.target.tagName === 'BUTTON') return;
    isDragging = true;
    startX = e.clientX - panel.offsetLeft;
    startY = e.clientY - panel.offsetTop;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

header.addEventListener('touchstart', function(e) {
    if (e.target.tagName === 'BUTTON') return;
    isDragging = true;
    var touch = e.touches[0];
    startX = touch.clientX - panel.offsetLeft;
    startY = touch.clientY - panel.offsetTop;
    document.addEventListener('touchmove', onTouchMove);
    document.addEventListener('touchend', onTouchEnd);
});

function onMouseMove(e) { if (isDragging) movePanel(e.clientX, e.clientY); }
function onTouchMove(e) { if (isDragging) movePanel(e.touches[0].clientX, e.touches[0].clientY); }

function movePanel(clientX, clientY) {
    var newX = Math.max(0, Math.min(clientX - startX, window.innerWidth - panel.offsetWidth));
    var newY = Math.max(0, Math.min(clientY - startY, document.getElementById('map-wrapper').clientHeight - panel.offsetHeight));
    panel.style.left = newX + 'px';
    panel.style.top = newY + 'px';
    panel.style.right = 'auto';
}

function onMouseUp() { isDragging = false; document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }
function onTouchEnd() { isDragging = false; document.removeEventListener('touchmove', onTouchMove); document.removeEventListener('touchend', onTouchEnd); }

function toggleVossenPanel() {
    var list = document.getElementById('vossen-list');
    var btn = document.getElementById('minimize-btn');
    if (list.style.display === 'none') {
        list.style.display = 'block';
        btn.innerText = '-';
    } else {
        list.style.display = 'none';
        btn.innerText = '+';
    }
}

var disabledBlinks = {};
function toggleBlink(teamName) {
    disabledBlinks[teamName] = !disabledBlinks[teamName];
    renderVossenUIFromData();
}

function zoomToLatestAreaPoint(teamName) {
    if (latestKnownAreaPoints[teamName] && latestKnownAreaPoints[teamName].latlng) {
        var pt = latestKnownAreaPoints[teamName];
        map.flyTo(pt.latlng, 15, { animate: true, duration: 1.2 });
        if (pt.marker) { setTimeout(function() { pt.marker.openPopup(); }, 600); }
    } else {
        alert("Nog geen RD-punt bekend voor deelgebied " + teamName);
    }
}

/* --- 13. JOTIHUNT API SYNC & NOTIFICATIES --- */
var previousAreaStatuses = {};
var isInitialAreaStatusSync = true;

function getNormalizedStatusCategory(rawStatus) {
    var s = String(rawStatus || '').toLowerCase().trim();
    if (s === 'inactief' || s === 'inactive' || s.includes('red') || s.includes('rood') || s.includes('gevangen') || s.includes('caught') || s === '0' || s === 'false') {
        return { key: 'rood', label: 'Rood (Inactief/Gevangen)' };
    } else if (s === 'actief' || s.includes('green') || s.includes('groen') || s === 'active' || s === 'field' || s === 'open' || s === 'vrij' || s === '1' || s === 'true') {
        return { key: 'groen', label: 'Groen (Actief)' };
    } else if (s.includes('rust') || s.includes('orange') || s.includes('oranje') || s.includes('yellow') || s.includes('geel') || s.includes('onderweg') || s === 'pause' || s === 'resting' || s === '2') {
        return { key: 'geel', label: 'Oranje/Geel (Rust)' };
    }
    return { key: 'grijs', label: 'Grijs (Onbekend)' };
}

function handleAreaStatusNotifications(areas) {
    if (!areas || !Array.isArray(areas)) return;

    var now = new Date();
    var timeString = String(now.getHours()).padStart(2, '0') + ":" + String(now.getMinutes()).padStart(2, '0');

    targetAreas.forEach(function(targetName) {
        var area = areas.find(function(a) {
            return (a.name || a.title || '').toLowerCase().includes(targetName.toLowerCase());
        });

        var raw = area ? (area.status || area.state || area.status_text || area.status_id || '') : '';
        var currentCategory = getNormalizedStatusCategory(raw);

        if (isInitialAreaStatusSync) {
            previousAreaStatuses[targetName] = currentCategory;
        } else {
            var prevCategory = previousAreaStatuses[targetName];
            if (prevCategory && prevCategory.key !== currentCategory.key) {
                var notifTitle = "🦊 Statuswijziging " + targetName;
                var notifBody = `${targetName} is om ${timeString} veranderd naar ${currentCategory.label}.`;

                if ('vibrate' in navigator) { navigator.vibrate([300, 100, 300, 100, 300]); }

                if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
                    navigator.serviceWorker.ready.then(function(reg) {
                        reg.showNotification(notifTitle, {
                            body: notifBody, icon: 'icon-192.png', badge: 'icon-192.png',
                            vibrate: [300, 100, 300, 100, 300], tag: 'status-alert-' + targetName, renotify: true
                        });
                    });
                }

                document.getElementById('notification-text').innerText = "🦊 " + notifBody;
                document.getElementById('notification-banner').style.display = 'flex';
                previousAreaStatuses[targetName] = currentCategory;
            } else if (!prevCategory) {
                previousAreaStatuses[targetName] = currentCategory;
            }
        }
    });

    if (isInitialAreaStatusSync) { isInitialAreaStatusSync = false; }
}

var lastCachedAreas = [];
var knownArticleId = localStorage.getItem('jh_last_article_id') || null;
var lastSyncTimeInFirebase = 0;

function renderVossenUIFromData() {
    if (!lastCachedAreas || lastCachedAreas.length === 0) return;
    var html = '';
    targetAreas.forEach(function(targetName) {
        var area = lastCachedAreas.find(function(a) {
            return (a.name || a.title || '').toLowerCase().includes(targetName.toLowerCase());
        });
        
        var raw = area ? (area.status || area.state || area.status_text || area.status_id || '') : '';
        var cat = getNormalizedStatusCategory(raw);
        var cls = 'status-vervangen';

        if (cat.key === 'rood') {
            cls = 'status-gevangen' + (disabledBlinks[targetName] ? '' : ' knipperen');
        } else if (cat.key === 'groen') {
            cls = 'status-actief';
        } else if (cat.key === 'geel') {
            cls = 'status-rust';
        }

        html += `<div class="vogel-status-item ${cls}" onclick="toggleBlink('${targetName}')" ondblclick="zoomToLatestAreaPoint('${targetName}')" title="Klik: knipperen aan/uit | Dubbelklik: zoom naar laatste RD punt">${targetName}</div>`;
    });
    document.getElementById('vossen-list').innerHTML = html;
}

db.ref('jotihuntSync').on('value', function(snapshot) {
    var data = snapshot.val();
    if (!data) return;

    if (data.lastSync) { lastSyncTimeInFirebase = data.lastSync; }

    if (data.areas) {
        var areasArray = Array.isArray(data.areas) ? data.areas : Object.values(data.areas);
        if (areasArray.length > 0) {
            lastCachedAreas = areasArray;
            renderVossenUIFromData();
            handleAreaStatusNotifications(areasArray);
        }
    }

    if (data.latestArticle && data.latestArticle.title) {
        var art = data.latestArticle;
        if (!knownArticleId || knownArticleId !== String(art.id)) {
            knownArticleId = String(art.id);
            localStorage.setItem('jh_last_article_id', knownArticleId);
            document.getElementById('notification-text').innerText = "🔔 Nieuw: " + art.title;
            document.getElementById('notification-banner').style.display = 'flex';
        }
    }

    document.getElementById('api-status').style.color = "#2ecc71";
});

async function fetchJotihuntEndpoint(endpoint) {
    var targetUrl = "https://jotihunt.nl/api/2.0/" + endpoint;

    // Route 1 is jouw eigen Cloudflare Worker!
    var routes = [
        {
            url: "https://jotihunt-proxy.joriskleijn2000.workers.dev/?url=" + encodeURIComponent(targetUrl),
            wrapped: false
        },
        {
            url: "https://api.allorigins.win/get?url=" + encodeURIComponent(targetUrl) + "&disableCache=" + Date.now(),
            wrapped: true
        },
        {
            url: "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(targetUrl),
            wrapped: false
        }
    ];

    for (var i = 0; i < routes.length; i++) {
        try {
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, 6000);

            var res = await fetch(routes[i].url, { cache: "no-store", signal: controller.signal });
            clearTimeout(timeoutId);

            if (!res.ok) continue;

            var json = await res.json();

            // AllOrigins pakt uit via contents, jouw Cloudflare worker levert direct schone JSON
            if (routes[i].wrapped) {
                if (!json || !json.contents) continue;
                if (typeof json.contents === 'string' && json.contents.trim().startsWith('<')) continue;
                json = JSON.parse(json.contents);
            }

            if (json && json.data) { return json.data; }
            else if (Array.isArray(json)) { return json; }
            else if (json && typeof json === 'object') { return json; }
        } catch (err) {
            // Mocht een route falen, probeer dan geruisloos de volgende route
        }
    }
    throw new Error("Geen enkele API-route werkte voor " + endpoint);
}

var isSyncingNow = false;
async function syncJotihuntToFirebase(forceManual = false) {
    if (isSyncingNow) return;

    var isDataStale = (Date.now() - lastSyncTimeInFirebase) > 60000;
    var isAreasEmpty = (!lastCachedAreas || lastCachedAreas.length === 0);

    if (!isAdmin && !isDataStale && !isAreasEmpty && !forceManual) return;

    isSyncingNow = true;
    var updatePayload = { lastSync: Date.Now ? Date.Now() : Date.now() };
    var anySuccess = false;

    // 1. Haal vossen/deelgebieden op
    try {
        var areasData = await fetchJotihuntEndpoint("areas");
        if (Array.isArray(areasData) && areasData.length > 0) {
            updatePayload.areas = areasData;
            lastCachedAreas = areasData;
            renderVossenUIFromData();
            anySuccess = true;
        }
    } catch (areaErr) {}

    await new Promise(function(r) { setTimeout(r, 1000); });

    // 2. Haal artikelen/meldingen op
    try {
        var artData = await fetchJotihuntEndpoint("articles");
        if (Array.isArray(artData) && artData.length > 0) {
            var sorted = artData.sort(function(a, b) { return (b.id || 0) - (a.id || 0); });
            updatePayload.latestArticle = sorted[0];
            anySuccess = true;
        }
    } catch (artErr) {}

    if (anySuccess) {
        try {
            await db.ref('jotihuntSync').update(updatePayload);
            document.getElementById('api-status').style.color = "#2ecc71";
        } catch (fbErr) {
            document.getElementById('api-status').style.color = "#e74c3c";
        }
    } else {
        document.getElementById('api-status').style.color = "#e74c3c";
    }

    isSyncingNow = false;
}

function fetchLatestArticleManual() {
    syncJotihuntToFirebase(true).then(function() {
        var art = document.getElementById('notification-text').innerText;
        if (art) document.getElementById('notification-banner').style.display = 'flex';
    });
}

setInterval(function() {
    syncJotihuntToFirebase(false);
}, 25000);