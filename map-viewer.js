/* ==========================================================================
   3. MAP-VIEWER.JS - LICHTGEWICHT KAARTWEERGAVE (VOOR HUNTERS & ADMIN)
   Leest kant-en-klare berekeningen uit Firebase ('computedMapState') zonder
   lokale CPU-belasting op mobiele telefoons.
   ========================================================================== */

var map = L.map('map', {
    preferCanvas: true
}).setView([51.9851, 5.8987], 10);

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

/* Kaartlagen */
var fixedHouseLayer = new L.FeatureGroup().addTo(map);
var drawnItems = new L.FeatureGroup().addTo(map);
var rdPointsLayer = new L.FeatureGroup().addTo(map);
var rdRouteLayer = new L.FeatureGroup().addTo(map);
var usersLiveLayer = new L.FeatureGroup().addTo(map);
var geofenceLayer = new L.FeatureGroup().addTo(map);
var compassRoseLayer = new L.FeatureGroup();

var liveUserMarkers = {};
var cachedUsersData = {};

/* Zoom-afhankelijke lagen (Geofences en Kompasroos vanaf zoomniveau 12) */
function checkZoomLevel() {
    if (map.getZoom() >= 12) {
        mapContainer.classList.add('zoom-in-to-show');
        if (!map.hasLayer(geofenceLayer)) map.addLayer(geofenceLayer);
        if (!map.hasLayer(compassRoseLayer)) map.addLayer(compassRoseLayer);
    } else {
        mapContainer.classList.remove('zoom-in-to-show');
        if (map.hasLayer(geofenceLayer)) map.removeLayer(geofenceLayer);
        if (map.hasLayer(compassRoseLayer)) map.removeLayer(compassRoseLayer);
    }
}
map.on('zoomend', checkZoomLevel);
checkZoomLevel();

/* --- AMALGAMA CLUBGEBOUW & 450M STRAAL --- */
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
].forEach(function (dir) {
    var icon = L.divIcon({
        className: 'compass-icon-wrapper',
        html: `<div class="compass-label">${dir.label}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11]
    });
    L.marker([dir.lat, dir.lng], { icon: icon, interactive: false }).addTo(compassRoseLayer);
});

/* --- 450M TEGENHUNT CIRKEL PER CLUBGEBOUW --- */
var houseMarkersMap = {};
var houseRadiusCircles = {};

function buildHousePopupHtml(loc) {
    var safeKey = loc.name.replace(/[.#$[\]]/g, '_');
    var isVisited = !!houseVisitedStatus[safeKey];
    var hasActiveRadius = !!houseRadiusCircles[safeKey];
    var escapedName = loc.name.replace(/'/g, "\\'");

    var visitedBtnHtml = '';
    if (isAdmin) {
        if (isVisited) {
            visitedBtnHtml = `<button onclick="window.toggleHouseVisited('${escapedName}')" style="margin-top:6px; background:#e67e22; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">↩️ Zet op niet bezocht</button>`;
        } else {
            visitedBtnHtml = `<button onclick="window.toggleHouseVisited('${escapedName}')" style="margin-top:6px; background:#27ae60; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">✔️ Markeer als bezocht</button>`;
        }
    }

    var radiusBtnText = hasActiveRadius ? "🚫 Verberg 450m Tegenhunt Cirkel" : "🎯 Toon 450m Tegenhunt Cirkel";
    var radiusBtnBg = hasActiveRadius ? "#c0392b" : "#8e44ad";
    var radiusBtnHtml = `<button onclick="window.toggleHouseRadius('${escapedName}', ${loc.lat}, ${loc.lng})" style="margin-top:6px; background:${radiusBtnBg}; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">${radiusBtnText}</button>`;

    return `<b>${loc.name}</b><br>Deelgebied: ${loc.area}<br>Status: ${isVisited ? '<span style="color:#e67e22;">Bezocht</span>' : '<span style="color:#2ecc71;">Niet bezocht</span>'}<br><button onclick="window.navigateToAreaPoint(${loc.lat},${loc.lng})" style="margin-top:6px; background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">📍 Navigeer via Google Maps</button>${radiusBtnHtml}${visitedBtnHtml}`;
}

window.toggleHouseRadius = function (houseName, lat, lng) {
    var safeKey = houseName.replace(/[.#$[\]]/g, '_');

    if (houseRadiusCircles[safeKey]) {
        map.removeLayer(houseRadiusCircles[safeKey]);
        delete houseRadiusCircles[safeKey];
    } else {
        var circle = L.circle([lat, lng], {
            radius: 450,
            color: '#9b59b6',
            weight: 2,
            dashArray: '5, 5',
            fillColor: '#9b59b6',
            fillOpacity: 0.15
        }).addTo(map);

        circle.bindTooltip("450m Tegenhunt: " + houseName, { direction: 'top' });
        houseRadiusCircles[safeKey] = circle;
    }

    // Update direct de popup-inhoud van dit specifieke huisje zodat de knoptekst mee verandert
    var locObj = allLocations.find(function (l) { return l.name === houseName; });
    if (locObj && houseMarkersMap[houseName]) {
        houseMarkersMap[houseName].setPopupContent(buildHousePopupHtml(locObj));
        houseMarkersMap[houseName].openPopup();
    }
};

function renderFixedHouses() {
    fixedHouseLayer.clearLayers();
    houseMarkersMap = {};

    if (!allLocations || allLocations.length === 0) return;

    allLocations.forEach(function (loc) {
        if (targetAreas.includes(loc.area)) {
            var areaColor = areaColors[loc.area] || "#3498db";
            var isOscar = (loc.area === "Oscar");
            var safeKey = loc.name.replace(/[.#$[\]]/g, '_');
            var isVisited = !!houseVisitedStatus[safeKey];
            var opacity = isVisited ? 0.5 : 1.0;

            var houseSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="${areaColor}" stroke="${isOscar ? "#003399" : "#000000"}" stroke-width="${isOscar ? 2 : 1}" style="opacity: ${opacity};">
                <path d="M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/>
            </svg>`;

            var customIcon = L.divIcon({
                className: 'custom-house-pin', html: houseSvg,
                iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
            });

            var marker = L.marker([loc.lat, loc.lng], { icon: customIcon });
            marker.bindTooltip(loc.name + " (" + loc.area + ")", { permanent: false, direction: 'right', className: 'marker-label' });

            marker.bindPopup(buildHousePopupHtml(loc));

            fixedHouseLayer.addLayer(marker);
            houseMarkersMap[loc.name] = marker;
        }
    });
}

/* --- CLUBGEBOUWEN (clubs.json) & BEZOCHT-STATUS --- */
fetch('clubs.json')
    .then(function (response) { return response.json(); })
    .then(function (data) {
        allLocations = data;
        renderFixedHouses();
        if (isAdmin && typeof window.calculateAndPublishMapState === 'function') {
            window.calculateAndPublishMapState();
        }
    })
    .catch(function (err) {
        console.warn("Kon clubs.json niet laden:", err);
    });

db.ref('houseVisited').on('value', function (snapshot) {
    houseVisitedStatus = snapshot.val() || {};
    renderFixedHouses();
    if (isAdmin && typeof window.calculateAndPublishMapState === 'function') {
        window.calculateAndPublishMapState();
    }
});

/* --- WEERGAVE VAN VOORBEREKENDE KAARTDATA ('computedMapState') --- */
var activeGeofenceCircles = {};
var activeGeofenceBadges = {};
var activeGeofenceArrows = {};

function createWalkerMarker(pt) {
    var isOscar = (pt.area === "Oscar");
    var strokeColor = isOscar ? "#003399" : "#000000";
    var walkerSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="${pt.color}" stroke="${strokeColor}" stroke-width="${isOscar ? 2 : 1.5}" style="opacity: ${pt.opacity};">
        <path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.2L6 8.3V13h2V9.6l1.8-.7z"/>
    </svg>`;

    var customIcon = L.divIcon({
        className: 'custom-walker-pin', html: walkerSvg,
        iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15]
    });

    var timeLabelPart = pt.time ? " (" + pt.time + ")" : "";
    var labelText = pt.name + timeLabelPart + (pt.extraInfo ? " • " + pt.extraInfo : "");
    var marker = L.marker(pt.latlng, { icon: customIcon });
    marker.bindTooltip(labelText, { permanent: false, direction: 'right', className: 'marker-label' });

    var popupContent = `<div style="font-size:12px; min-width:190px;">
        <b>${pt.name}</b><br>
        ${pt.time ? `<span>Tijd: <b>${pt.time}</b></span><br>` : ''}
        ${pt.extraInfo ? `<span>Loopsnelheid: <b style="color:#27ae60;">${pt.extraInfo}</b></span><br>` : ''}
        <button onclick="window.navigateToAreaPoint(${pt.latlng[0]}, ${pt.latlng[1]})" style="background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; width:100%; margin-top:6px; font-weight:bold;">
            📍 Navigeer naar dit punt
        </button>
        ${(isAdmin && pt.key) ? `
            <hr style="margin:6px 0; border:0; border-top:1px solid #4a627a;">
            <div style="display:flex; gap:5px; margin-top:4px;">
                <button onclick="window.editRdPointPopup('${pt.key}')" style="background:#f39c12; color:white; border:none; padding:4px 6px; border-radius:3px; cursor:pointer; font-weight:bold; flex:1;">✏️ Bewerk</button>
                <button onclick="window.deleteRdPointPopup('${pt.key}')" style="background:#e74c3c; color:white; border:none; padding:4px 6px; border-radius:3px; cursor:pointer; font-weight:bold; flex:1;">🗑️ Wis</button>
            </div>
        ` : ''}
    </div>`;
    marker.bindPopup(popupContent);
    return marker;
}

// Luister naar de door Admin voorberekende kaartstatus
db.ref('computedMapState').on('value', function (snapshot) {
    var state = snapshot.val();
    renderComputedMapState(state);
});

function renderComputedMapState(state) {
    rdPointsLayer.clearLayers();
    rdRouteLayer.clearLayers();
    latestKnownAreaPoints = {};

    var areasData = (state && state.areas) ? state.areas : {};
    var otherPoints = (state && state.otherPoints) ? state.otherPoints : [];

    // Teken eerst eventuele losse 'Anders'-punten (zonder deelgebied/tijd)
    if (Array.isArray(otherPoints)) {
        otherPoints.forEach(function (pt) {
            var marker = createWalkerMarker(pt);
            rdPointsLayer.addLayer(marker);
        });
    }

    // Verwijder geofences van deelgebieden die gewist zijn
    Object.keys(activeGeofenceCircles).forEach(function (area) {
        if (!areasData[area]) {
            geofenceLayer.removeLayer(activeGeofenceCircles[area]);
            delete activeGeofenceCircles[area];
            if (activeGeofenceBadges[area]) {
                geofenceLayer.removeLayer(activeGeofenceBadges[area]);
                delete activeGeofenceBadges[area];
            }
            if (activeGeofenceArrows[area]) {
                activeGeofenceArrows[area].forEach(function (l) { geofenceLayer.removeLayer(l); });
                delete activeGeofenceArrows[area];
            }
        }
    });

    Object.keys(areasData).forEach(function (area) {
        var areaObj = areasData[area];
        if (!areaObj || !areaObj.points || areaObj.points.length === 0) return;

        // 1. Teken voorberekende RD-punten van het deelgebied
        areaObj.points.forEach(function (pt) {
            var marker = createWalkerMarker(pt);
            rdPointsLayer.addLayer(marker);
            if (pt.isLatest) {
                latestKnownAreaPoints[area] = {
                    latlng: pt.latlng,
                    marker: marker
                };
            }
        });

        // 2. Teken voorberekende routelijn
        if (areaObj.routeCoords && areaObj.routeCoords.length >= 2) {
            var polyline = L.polyline(areaObj.routeCoords, {
                color: areaObj.lineColor || areaColors[area] || "#000000",
                weight: 4,
                className: 'route-line'
            });
            polyline.bindPopup("<b>Chronologische route: " + area + "</b>");
            rdRouteLayer.addLayer(polyline);
        }

        // 3. Teken of update voorberekende Geofence & Pijlen (zonder flikkering!)
        if (areaObj.geofence) {
            var gf = areaObj.geofence;

            // Update bestaande cirkel of maak een nieuwe aan
            if (activeGeofenceCircles[area]) {
                activeGeofenceCircles[area].setLatLng(gf.center);
                activeGeofenceCircles[area].setRadius(gf.radiusMeters);
            } else {
                var circle = L.circle(gf.center, {
                    radius: gf.radiusMeters, color: gf.color, weight: 2,
                    dashArray: '6, 6', fillColor: gf.color, fillOpacity: 0.12, interactive: false
                });
                geofenceLayer.addLayer(circle);
                activeGeofenceCircles[area] = circle;
            }

            // Update bestaande badge of maak een nieuwe aan
            var badgeIcon = L.divIcon({
                className: 'geofence-badge-wrapper',
                html: `<div class="geofence-radius-badge" style="border-color:${gf.color};">${gf.badgeText}</div>`,
                iconSize: [80, 20], iconAnchor: [40, 10]
            });
            if (activeGeofenceBadges[area]) {
                activeGeofenceBadges[area].setLatLng(gf.center);
                activeGeofenceBadges[area].setIcon(badgeIcon);
            } else {
                var badgeMarker = L.marker(gf.center, { icon: badgeIcon, interactive: false });
                geofenceLayer.addLayer(badgeMarker);
                activeGeofenceBadges[area] = badgeMarker;
            }

            // Oude pijlen van dit gebied vervangen door de nieuw berekende pijlen
            if (activeGeofenceArrows[area]) {
                activeGeofenceArrows[area].forEach(function (l) { geofenceLayer.removeLayer(l); });
            }
            activeGeofenceArrows[area] = [];

            if (gf.arrows && Array.isArray(gf.arrows)) {
                gf.arrows.forEach(function (arr) {
                    var arrowLine = L.polyline([gf.center, arr.endCoord], {
                        color: gf.color, weight: 2.5, dashArray: '4, 4', opacity: 0.85, interactive: false
                    });
                    geofenceLayer.addLayer(arrowLine);
                    activeGeofenceArrows[area].push(arrowLine);

                    var tipSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" style="transform: rotate(${arr.angle}deg);">
                        <polygon points="12,2 22,22 12,17 2,22" fill="${gf.color}" stroke="#ffffff" stroke-width="1.5"/>
                    </svg>`;
                    var tipIcon = L.divIcon({
                        className: 'arrow-tip-icon', html: tipSvg, iconSize: [20, 20], iconAnchor: [10, 10]
                    });
                    var tipMarker = L.marker(arr.endCoord, { icon: tipIcon, interactive: false });
                    geofenceLayer.addLayer(tipMarker);
                    activeGeofenceArrows[area].push(tipMarker);
                });
            }
        }
    });
}

/* --- PUSHMELDING BIJ NIEUW GEPLAATST RD-PUNT --- */
var isInitialRdLoad = true;
db.ref('rdPoints').once('value', function () { isInitialRdLoad = false; });

db.ref('rdPoints').on('child_added', function (snapshot) {
    if (isInitialRdLoad) return;
    var p = snapshot.val();
    if (!p) return;

    var now = Date.now();
    var itemTime = p.createdAt || p.createdTimestamp || now;
    if (now - itemTime < 15 * 60 * 1000) {
        var puntNaam = p.fullName || p.baseName || "Nieuw punt";
        var deelgebied = p.area ? " in " + p.area : "";
        var tijdTekst = p.time ? " (" + p.time + ")" : "";

        if ('vibrate' in navigator) { navigator.vibrate([300, 100, 300, 100, 300]); }

        if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
            navigator.serviceWorker.ready.then(function (reg) {
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

/* --- LIVE GEBRUIKERS & HUNTERS OP DE KAART --- */
function createUserIcon(isActive) {
    var fillColor = isActive ? "#2ecc71" : "#7f8c8d";
    var strokeColor = isActive ? "#ffffff" : "#e74c3c";
    var strokeWidth = isActive ? 1.5 : 2;

    var userSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}">
        <path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/>
    </svg>`;

    return L.divIcon({
        className: 'custom-car-pin', html: userSvg,
        iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16]
    });
}

db.ref('liveUsers').on('value', function (snapshot) {
    var users = snapshot.val();
    var now = Date.now();

    if (!users) {
        cachedUsersData = {};
        usersLiveLayer.clearLayers();
        liveUserMarkers = {};
        return;
    }

    cachedUsersData = users;

    Object.keys(users).forEach(function (userId) {
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

        targetAreas.forEach(function (areaName) {
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

    Object.keys(liveUserMarkers).forEach(function (userId) {
        if (!users[userId]) {
            usersLiveLayer.removeLayer(liveUserMarkers[userId]);
            delete liveUserMarkers[userId];
        }
    });
});

/* --- VOSSEN PANEEL SLEPEN & STATUS LUISTERAAR --- */
var panel = document.getElementById('vossen-status-panel');
var header = document.getElementById('vossen-status-header');
var isDragging = false, startX, startY;

header.addEventListener('mousedown', function (e) {
    if (e.target.tagName === 'BUTTON') return;
    isDragging = true;
    startX = e.clientX - panel.offsetLeft;
    startY = e.clientY - panel.offsetTop;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

header.addEventListener('touchstart', function (e) {
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

function toggleBlink(teamName) {
    disabledBlinks[teamName] = !disabledBlinks[teamName];
    renderVossenUIFromData();
}

function zoomToLatestAreaPoint(teamName) {
    if (latestKnownAreaPoints[teamName] && latestKnownAreaPoints[teamName].latlng) {
        var pt = latestKnownAreaPoints[teamName];
        map.flyTo(pt.latlng, 15, { animate: true, duration: 1.2 });
        if (pt.marker) { setTimeout(function () { pt.marker.openPopup(); }, 600); }
    } else {
        alert("Nog geen RD-punt bekend voor deelgebied " + teamName);
    }
}

function renderVossenUIFromData() {
    if (!lastCachedAreas || lastCachedAreas.length === 0) return;
    var html = '';
    targetAreas.forEach(function (targetName) {
        var area = lastCachedAreas.find(function (a) {
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

/* Luister naar Vossenstatus & Artikelen vanuit Firebase */
var previousAreaStatuses = {};
var isInitialAreaStatusSync = true;
var knownArticleId = localStorage.getItem('jh_last_article_id') || null;

function handleAreaStatusNotifications(areas) {
    if (!areas || !Array.isArray(areas)) return;

    var now = new Date();
    var timeString = String(now.getHours()).padStart(2, '0') + ":" + String(now.getMinutes()).padStart(2, '0');

    targetAreas.forEach(function (targetName) {
        var area = areas.find(function (a) {
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
                    navigator.serviceWorker.ready.then(function (reg) {
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

db.ref('jotihuntSync').on('value', function (snapshot) {
    var data = snapshot.val();
    if (!data) return;

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