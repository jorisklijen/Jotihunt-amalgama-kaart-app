/* ==========================================================================
   3. MAP-VIEWER.JS - LICHTGEWICHT KAARTWEERGAVE (VOOR HUNTERS & ADMIN)
   Inclusief:
   - Vast Vossen Info-Venster (100% flikkervrij, los van de knoppenlijst)
   - Duidelijke In-App Melding + Geluid wanneer een deelgebied weer op GROEN springt
   - Centrale TEGENHUNT Popup midden op het scherm met grote aftel-timer,
     windrichting, tijdstip + automatisch inzoomen op Scouting Amalgama
   - Snellere 10-seconden kaart-refresh
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

function applyDarkMode(enabled) {
    if (enabled) {
        if (map.hasLayer(lightTileLayer)) map.removeLayer(lightTileLayer);
        if (!map.hasLayer(darkLayerGroup)) darkLayerGroup.addTo(map);
        mapContainer.classList.add('dark-mode-map');
        document.getElementById('btn-darkmode').innerText = "☀️ Light";
        localStorage.setItem('jh_map_theme', 'dark');
    } else {
        if (map.hasLayer(darkLayerGroup)) map.removeLayer(darkLayerGroup);
        if (!map.hasLayer(lightTileLayer)) lightTileLayer.addTo(map);
        mapContainer.classList.remove('dark-mode-map');
        document.getElementById('btn-darkmode').innerText = "🌙 Dark";
        localStorage.setItem('jh_map_theme', 'light');
    }
}
applyDarkMode(isDarkMode);

function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    applyDarkMode(isDarkMode);
}

/* --- GELUIDSSIGNAAL HULPFUNCTIE (WEB AUDIO API - GEEN EXTERNE MP3 NODIG) --- */
function playAlertSound(type) {
    try {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        var ctx = new AudioCtx();

        if (type === 'counterhunt') {
            // Urgent alarm-signaal voor Tegenhunt
            [0, 0.25, 0.5, 0.75].forEach(function(offset, idx) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(idx % 2 === 0 ? 880 : 620, ctx.currentTime + offset);
                gain.gain.setValueAtTime(0.22, ctx.currentTime + offset);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + offset + 0.22);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(ctx.currentTime + offset);
                osc.stop(ctx.currentTime + offset + 0.23);
            });
        } else if (type === 'green' || type === 'foiled') {
            // Positief oplopend signaal voor Vossen Groen / Tegenhunt Verijdeld
            [523.25, 659.25, 783.99, 1046.5].forEach(function(freq, idx) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = 'triangle';
                var startT = ctx.currentTime + (idx * 0.12);
                osc.frequency.setValueAtTime(freq, startT);
                gain.gain.setValueAtTime(0.2, startT);
                gain.gain.exponentialRampToValueAtTime(0.008, startT + 0.22);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(startT);
                osc.stop(startT + 0.24);
            });
        }
    } catch (e) {}
}

/* --- DYNAMISCHE MAATSTAAF (SCALE BAR) ONDERAAN DE KAART --- */
var CustomScaleBar = L.Control.extend({
    options: {
        position: 'bottomleft',
        maxWidth: 110
    },
    onAdd: function (mapInstance) {
        var container = L.DomUtil.create('div', 'jh-scale-control leaflet-control');
        this._textEl = L.DomUtil.create('span', 'jh-scale-text', container);
        this._bracketEl = L.DomUtil.create('div', 'jh-scale-bracket', container);

        mapInstance.on('zoomend moveend resize', this._update, this);
        this._map = mapInstance;
        this._update();
        return container;
    },
    onRemove: function (mapInstance) {
        mapInstance.off('zoomend moveend resize', this._update, this);
    },
    _update: function () {
        if (!this._map) return;
        var mapSize = this._map.getSize();
        if (!mapSize || mapSize.y <= 0) return;

        var y = mapSize.y / 2;
        var maxWidthPx = this.options.maxWidth || 110;
        var p1 = this._map.containerPointToLatLng([0, y]);
        var p2 = this._map.containerPointToLatLng([maxWidthPx, y]);
        var maxMeters = this._map.distance(p1, p2);

        if (!maxMeters || maxMeters <= 0 || isNaN(maxMeters)) return;

        var niceMeters = this._getRoundNum(maxMeters);
        var ratio = niceMeters / maxMeters;
        var barWidthPx = Math.max(24, Math.round(maxWidthPx * ratio));

        this._bracketEl.style.width = barWidthPx + 'px';
        this._textEl.innerText = niceMeters >= 1000 ? (niceMeters / 1000) + ' km' : niceMeters + ' m';
    },
    _getRoundNum: function (num) {
        var pow10 = Math.pow(10, (Math.floor(num) + '').length - 1);
        var d = num / pow10;
        d = d >= 10 ? 10 :
            d >= 5 ? 5 :
            d >= 3 ? 3 :
            d >= 2 ? 2 : 1;
        return pow10 * d;
    }
});
map.addControl(new CustomScaleBar());

/* Kaartlagen */
var fixedHouseLayer = new L.FeatureGroup().addTo(map);
var drawnItems = new L.FeatureGroup().addTo(map);
var rdPointsLayer = new L.FeatureGroup().addTo(map);
var rdRouteLayer = new L.FeatureGroup().addTo(map);
var usersLiveLayer = new L.FeatureGroup().addTo(map);
var geofenceLayer = new L.FeatureGroup().addTo(map);
var compassRoseLayer = new L.FeatureGroup();
var counterHuntHighlightLayer = new L.FeatureGroup().addTo(map);

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
var amalgamaBaseCircle = L.circle([amalgamaLat, amalgamaLng], {
    radius: radiusMeters, color: '#e67e22', weight: 2, dashArray: '5, 5',
    fillColor: '#e67e22', fillOpacity: 0.12
}).addTo(map).bindTooltip("450m Straal Scouting Amalgama", { direction: 'top' });

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

/* --- 450M TEGENHUNT CIRKEL & BEZOCHT-TIJDSTIP PER CLUBGEBOUW --- */
var houseMarkersMap = {};
var houseRadiusCircles = {};

function formatTimestampLocalIso(tsMs) {
    var d = (tsMs && tsMs > 1000) ? new Date(Number(tsMs)) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function formatVisitedDisplayTime(rawVal) {
    var ts = null;
    if (typeof rawVal === 'number' && rawVal > 1000) ts = rawVal;
    else if (typeof rawVal === 'object' && rawVal && rawVal.visitedAt) ts = Number(rawVal.visitedAt);

    if (!ts || isNaN(ts)) return "";
    var d = new Date(ts);
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}-${mm} ${hh}:${min}`;
}

function buildHousePopupHtml(loc) {
    var safeKey = loc.name.replace(/[.#$[\]]/g, '_');
    var rawVisitedVal = houseVisitedStatus[safeKey];
    var isVisited = !!rawVisitedVal;
    var hasActiveRadius = !!houseRadiusCircles[safeKey];
    var escapedName = loc.name.replace(/'/g, "\\'");

    var visitedTimeFormatted = isVisited ? formatVisitedDisplayTime(rawVisitedVal) : "";
    var existingTs = (typeof rawVisitedVal === 'number' && rawVisitedVal > 1000)
        ? rawVisitedVal
        : (rawVisitedVal && rawVisitedVal.visitedAt ? Number(rawVisitedVal.visitedAt) : null);
    var defaultIsoVal = formatTimestampLocalIso(existingTs);

    var visitedBtnHtml = '';
    if (isAdmin) {
        visitedBtnHtml = `
            <hr style="margin:7px 0 5px 0; border:0; border-top:1px solid #4a627a;">
            <label style="font-size:11px; color:#bdc3c7; font-weight:bold; display:block; margin-bottom:3px;">🕒 Bezoektijdstip (voor RD-looplijn):</label>
            <input type="datetime-local" id="house_dt_${safeKey}" value="${defaultIsoVal}" style="width:100%; padding:4px 6px; font-size:11px; font-weight:bold; margin-bottom:4px;">
        `;
        if (isVisited) {
            visitedBtnHtml += `
                <div style="display:flex; gap:5px;">
                    <button onclick="window.saveHouseVisitedWithTime('${escapedName}', 'house_dt_${safeKey}')" style="background:#27ae60; color:white; border:none; padding:5px 6px; border-radius:3px; cursor:pointer; font-weight:bold; flex:1;">💾 Update tijd</button>
                    <button onclick="window.clearHouseVisited('${escapedName}')" style="background:#e67e22; color:white; border:none; padding:5px 6px; border-radius:3px; cursor:pointer; font-weight:bold; flex:1;">↩️ Niet bezocht</button>
                </div>
            `;
        } else {
            visitedBtnHtml += `
                <button onclick="window.saveHouseVisitedWithTime('${escapedName}', 'house_dt_${safeKey}')" style="background:#27ae60; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">✔️ Markeer als bezocht op tijdstip</button>
            `;
        }
    }

    var radiusBtnText = hasActiveRadius ? "🚫 Verberg 450m Tegenhunt Cirkel" : "🎯 Toon 450m Tegenhunt Cirkel";
    var radiusBtnBg = hasActiveRadius ? "#c0392b" : "#8e44ad";
    var radiusBtnHtml = `<button onclick="window.toggleHouseRadius('${escapedName}', ${loc.lat}, ${loc.lng})" style="margin-top:6px; background:${radiusBtnBg}; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">${radiusBtnText}</button>`;

    var statusHtml = isVisited
        ? `<span style="color:#e67e22; font-weight:bold;">Bezocht${visitedTimeFormatted ? ' (' + visitedTimeFormatted + ')' : ' (Tegenhunt)'}</span>`
        : `<span style="color:#2ecc71; font-weight:bold;">Niet bezocht</span>`;

    return `<div style="min-width:205px;">
        <b>${loc.name}</b><br>
        Deelgebied: ${loc.area}<br>
        Status: ${statusHtml}<br>
        <button onclick="window.navigateToAreaPoint(${loc.lat},${loc.lng})" style="margin-top:6px; background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; font-weight:bold; width:100%;">📍 Navigeer via Google Maps</button>
        ${radiusBtnHtml}
        ${visitedBtnHtml}
    </div>`;
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
            var rawVisited = houseVisitedStatus[safeKey];
            var isVisited = !!rawVisited;
            var opacity = isVisited ? 0.55 : 1.0;

            var houseSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="${areaColor}" stroke="${isOscar ? "#003399" : "#000000"}" stroke-width="${isOscar ? 2 : 1}" style="opacity: ${opacity};">
                <path d="M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/>
            </svg>`;

            var customIcon = L.divIcon({
                className: 'custom-house-pin', html: houseSvg,
                iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
            });

            var timeSuffix = isVisited ? formatVisitedDisplayTime(rawVisited) : "";
            var tooltipLabel = loc.name + " (" + loc.area + ")" + (timeSuffix ? " • Bezocht " + timeSuffix : "");

            var marker = L.marker([loc.lat, loc.lng], { icon: customIcon });
            marker.bindTooltip(tooltipLabel, { permanent: false, direction: 'right', className: 'marker-label' });

            marker.bindPopup(buildHousePopupHtml(loc));

            fixedHouseLayer.addLayer(marker);
            houseMarkersMap[loc.name] = marker;
        }
    });
}

/* --- CLUBGEBOUWEN (clubs.json) & BEZOCHT-STATUS --- */
var lastComputedMapState = null;

fetch('clubs.json')
    .then(function (response) { return response.json(); })
    .then(function (data) {
        allLocations = data;
        renderFixedHouses();
        if (lastComputedMapState) {
            renderComputedMapState(lastComputedMapState);
        }
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
    if (lastComputedMapState) {
        renderComputedMapState(lastComputedMapState);
    }
    if (isAdmin && typeof window.calculateAndPublishMapState === 'function') {
        window.calculateAndPublishMapState();
    }
});

/* --- WEERGAVE VAN VOORBEREKENDE KAARTDATA ('computedMapState') --- */
var activeGeofenceCircles = {};
var activeGeofenceBadges = {};
var activeGeofenceArrows = {};
var activeEstimatedRoutes = {};
var activeAlternativeRoutes = {};
var activeIntersectionDots = {};
var activeLiveExpectedFoxMarkers = {};
var activeAltExpectedFoxMarkers = {};

function createWalkerMarker(pt) {
    var isOscar = (pt.area === "Oscar");
    var strokeColor = isOscar ? "#003399" : "#000000";
    var customIcon;

    if (pt.isLatest) {
        var walkerSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="${pt.color}" stroke="${strokeColor}" stroke-width="${isOscar ? 2 : 1.5}" style="opacity: ${pt.opacity};">
            <path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.2L6 8.3V13h2V9.6l1.8-.7z"/>
        </svg>`;

        customIcon = L.divIcon({
            className: 'custom-walker-pin', html: walkerSvg,
            iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15]
        });
    } else {
        var dotBorderColor = "#ffffff";
        var dotHtml = `<div class="custom-rd-dot" style="background-color: ${pt.color}; border: 2px solid ${dotBorderColor}; opacity: ${pt.opacity};"></div>`;

        customIcon = L.divIcon({
            className: 'custom-rd-dot-wrapper', html: dotHtml,
            iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6]
        });
    }

    var timeLabelPart = pt.time ? " (" + pt.time + ")" : "";
    var labelText = pt.name + timeLabelPart + (pt.extraInfo ? " • " + pt.extraInfo : "");
    var marker = L.marker(pt.latlng, { icon: customIcon });
    marker.bindTooltip(labelText, { permanent: false, direction: 'right', className: 'marker-label' });

    var targetLockHtml = '';
    if (isAdmin && pt.isLatest && pt.area) {
        var areaHouses = allLocations.filter(function(l) { return l.area === pt.area; });
        var unvisitedHouses = areaHouses.filter(function(h) {
            var sKey = h.name.replace(/[.#$[\]]/g, '_');
            return !houseVisitedStatus[sKey];
        });
        var currentLocked = pt.lockedTarget || "";
        var autoLabel = pt.autoTarget ? `🤖 Auto (${pt.autoTarget})` : `🤖 Automatisch (Slim)`;

        var lockOptions = `<option value="">${autoLabel}</option>`;
        unvisitedHouses.forEach(function(h) {
            var selectedAttr = (h.name === currentLocked) ? 'selected' : '';
            lockOptions += `<option value="${h.name.replace(/"/g, '&quot;')}" ${selectedAttr}>🔒 Lock: ${h.name}</option>`;
        });

        targetLockHtml = `
            <hr style="margin:6px 0; border:0; border-top:1px solid #4a627a;">
            <label style="font-size:11px; color:#bdc3c7; font-weight:bold; display:block; margin-bottom:3px;">🎯 Doel-clubhuis (Route):</label>
            <select onchange="if(window.setAreaLockedTarget) window.setAreaLockedTarget('${pt.area}', this.value)" style="width:100%; padding:4px; font-size:11px; font-weight:bold;">
                ${lockOptions}
            </select>
        `;
    } else if (pt.isLatest && pt.lockedTarget) {
        targetLockHtml = `<span style="font-size:11px; color:#f1c40f;">🔒 Gelockt doel: <b>${pt.lockedTarget}</b></span><br>`;
    }

    var popupContent = `<div style="font-size:12px; min-width:195px;">
        <b>${pt.name}</b><br>
        ${pt.time ? `<span>Tijd: <b>${pt.time}</b></span><br>` : ''}
        ${pt.extraInfo ? `<span>Loopsnelheid: <b style="color:#2ecc71;">${pt.extraInfo}</b></span><br>` : ''}
        ${(!isAdmin ? targetLockHtml : '')}
        <button onclick="window.navigateToAreaPoint(${pt.latlng[0]}, ${pt.latlng[1]})" style="background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; width:100%; margin-top:6px; font-weight:bold;">
            📍 Navigeer naar dit punt
        </button>
        ${(isAdmin ? targetLockHtml : '')}
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

function getFallbackLatestVisitedHouseForArea(areaName) {
    if (!allLocations || allLocations.length === 0) return null;
    var areaHouses = allLocations.filter(function(l) { return l.area === areaName; });
    var bestHouse = null;
    var bestTs = -1;

    areaHouses.forEach(function(h) {
        var safeKey = h.name.replace(/[.#$[\]]/g, '_');
        var rawVal = houseVisitedStatus[safeKey];
        if (!rawVal) return;
        var ts = 1;
        if (typeof rawVal === 'number' && rawVal > 1000) ts = rawVal;
        else if (typeof rawVal === 'object' && rawVal.visitedAt) ts = Number(rawVal.visitedAt);

        if (ts >= bestTs) {
            bestTs = ts;
            bestHouse = h;
        }
    });

    if (bestHouse) {
        return {
            latlng: [bestHouse.lat, bestHouse.lng],
            marker: houseMarkersMap[bestHouse.name] || null,
            isHouse: true,
            houseName: bestHouse.name
        };
    }
    return null;
}

// Luister naar de door Admin voorberekende kaartstatus
db.ref('computedMapState').on('value', function (snapshot) {
    lastComputedMapState = snapshot.val();
    renderComputedMapState(lastComputedMapState);
    window.renderFoxStatusButtons();
});

function renderComputedMapState(state) {
    rdPointsLayer.clearLayers();
    rdRouteLayer.clearLayers();
    latestKnownAreaPoints = {};

    var areasData = (state && state.areas) ? state.areas : {};
    var otherPoints = (state && state.otherPoints) ? state.otherPoints : [];

    if (Array.isArray(otherPoints)) {
        otherPoints.forEach(function (pt) {
            var marker = createWalkerMarker(pt);
            rdPointsLayer.addLayer(marker);
        });
    }

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
            if (activeEstimatedRoutes[area]) {
                geofenceLayer.removeLayer(activeEstimatedRoutes[area]);
                delete activeEstimatedRoutes[area];
            }
            if (activeAlternativeRoutes[area]) {
                geofenceLayer.removeLayer(activeAlternativeRoutes[area]);
                delete activeAlternativeRoutes[area];
            }
            if (activeIntersectionDots[area]) {
                geofenceLayer.removeLayer(activeIntersectionDots[area]);
                delete activeIntersectionDots[area];
            }
            if (activeLiveExpectedFoxMarkers[area]) {
                geofenceLayer.removeLayer(activeLiveExpectedFoxMarkers[area]);
                delete activeLiveExpectedFoxMarkers[area];
            }
            if (activeAltExpectedFoxMarkers[area]) {
                geofenceLayer.removeLayer(activeAltExpectedFoxMarkers[area]);
                delete activeAltExpectedFoxMarkers[area];
            }
        }
    });

    Object.keys(areasData).forEach(function (area) {
        var areaObj = areasData[area];
        if (!areaObj || !areaObj.points || areaObj.points.length === 0) return;

        var latestRdMarker = null;
        var latestRdLatLng = null;

        areaObj.points.forEach(function (pt) {
            var marker = createWalkerMarker(pt);
            rdPointsLayer.addLayer(marker);
            if (pt.isLatest) {
                latestRdMarker = marker;
                latestRdLatLng = pt.latlng;
            }
        });

        var lineTailLatLng = latestRdLatLng;
        if (areaObj.geofence && Array.isArray(areaObj.geofence.center) && areaObj.geofence.center.length === 2) {
            lineTailLatLng = areaObj.geofence.center;
        } else if (areaObj.routeCoords && areaObj.routeCoords.length > 0) {
            lineTailLatLng = areaObj.routeCoords[areaObj.routeCoords.length - 1];
        }

        if (lineTailLatLng) {
            var matchedClub = allLocations.find(function (loc) {
                return loc.area === area && getDistanceKm(lineTailLatLng[0], lineTailLatLng[1], loc.lat, loc.lng) <= 0.015;
            });

            if (matchedClub && houseMarkersMap[matchedClub.name]) {
                latestKnownAreaPoints[area] = {
                    latlng: [matchedClub.lat, matchedClub.lng],
                    marker: houseMarkersMap[matchedClub.name],
                    isHouse: true,
                    houseName: matchedClub.name
                };
            } else {
                var isSameAsLatestRd = latestRdLatLng && getDistanceKm(lineTailLatLng[0], lineTailLatLng[1], latestRdLatLng[0], latestRdLatLng[1]) <= 0.015;
                latestKnownAreaPoints[area] = {
                    latlng: lineTailLatLng,
                    marker: isSameAsLatestRd ? latestRdMarker : null,
                    isHouse: false
                };
            }
        }

        if (areaObj.routeCoords && areaObj.routeCoords.length >= 2) {
            var polyline = L.polyline(areaObj.routeCoords, {
                color: areaObj.lineColor || areaColors[area] || "#000000",
                weight: 4,
                className: 'route-line'
            });
            polyline.bindPopup("<b>Chronologische route: " + area + "</b>");
            rdRouteLayer.addLayer(polyline);
        }

        if (areaObj.geofence) {
            var gf = areaObj.geofence;
            var circleColor = gf.color || "#7f8c8d";
            var routeAreaColor = gf.areaColor || areaColors[area] || gf.color;

            if (activeGeofenceCircles[area]) {
                activeGeofenceCircles[area].setLatLng(gf.center);
                activeGeofenceCircles[area].setRadius(gf.radiusMeters);
                activeGeofenceCircles[area].setStyle({
                    color: circleColor,
                    fillColor: circleColor,
                    fillOpacity: gf.isCappedByAge ? 0.16 : 0.12
                });
            } else {
                var circle = L.circle(gf.center, {
                    radius: gf.radiusMeters, color: circleColor, weight: 2,
                    dashArray: '6, 6', fillColor: circleColor, fillOpacity: gf.isCappedByAge ? 0.16 : 0.12, interactive: false
                });
                geofenceLayer.addLayer(circle);
                activeGeofenceCircles[area] = circle;
            }

            var badgeIcon = L.divIcon({
                className: 'geofence-badge-wrapper',
                html: `<div class="geofence-radius-badge" style="border-color:${circleColor};">${gf.badgeText}</div>`,
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

            if (activeGeofenceArrows[area]) {
                activeGeofenceArrows[area].forEach(function (l) { geofenceLayer.removeLayer(l); });
            }
            activeGeofenceArrows[area] = [];

            if (gf.arrows && Array.isArray(gf.arrows)) {
                gf.arrows.forEach(function (arr) {
                    var arrowLine = L.polyline([gf.center, arr.endCoord], {
                        color: circleColor, weight: 2.5, dashArray: '4, 4', opacity: 0.85, interactive: false
                    });
                    geofenceLayer.addLayer(arrowLine);
                    activeGeofenceArrows[area].push(arrowLine);

                    var tipSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" style="transform: rotate(${arr.angle}deg);">
                        <polygon points="12,2 22,22 12,17 2,22" fill="${circleColor}" stroke="#ffffff" stroke-width="1.5"/>
                    </svg>`;
                    var tipIcon = L.divIcon({
                        className: 'arrow-tip-icon', html: tipSvg, iconSize: [20, 20], iconAnchor: [10, 10]
                    });
                    var tipMarker = L.marker(arr.endCoord, { icon: tipIcon, interactive: false });
                    geofenceLayer.addLayer(tipMarker);
                    activeGeofenceArrows[area].push(tipMarker);
                });
            }

            if (activeEstimatedRoutes[area]) {
                geofenceLayer.removeLayer(activeEstimatedRoutes[area]);
                delete activeEstimatedRoutes[area];
            }
            if (gf.estimatedWalkRoute && Array.isArray(gf.estimatedWalkRoute) && gf.estimatedWalkRoute.length >= 2) {
                var walkLine = L.polyline(gf.estimatedWalkRoute, {
                    color: routeAreaColor,
                    weight: 3.5,
                    dashArray: '4, 8',
                    opacity: 0.92,
                    className: 'estimated-walk-line'
                });
                var targetHouseLabel = gf.estimatedTargetHouse ? `<br>Doelroute: <b>${gf.estimatedTargetHouse}</b>` : '';
                var visitedNote = gf.visitedOriginHouse ? `<br>Herkomst (bezocht): <b>${gf.visitedOriginHouse}</b>` : '';
                walkLine.bindPopup(`<b>🥾 Primaire voorspelde looproute (${area})</b>${targetHouseLabel}${visitedNote}`);
                geofenceLayer.addLayer(walkLine);
                activeEstimatedRoutes[area] = walkLine;
            }

            if (activeAlternativeRoutes[area]) {
                geofenceLayer.removeLayer(activeAlternativeRoutes[area]);
                delete activeAlternativeRoutes[area];
            }
            if (gf.alternativeWalkRoute && Array.isArray(gf.alternativeWalkRoute) && gf.alternativeWalkRoute.length >= 2) {
                var altLine = L.polyline(gf.alternativeWalkRoute, {
                    color: routeAreaColor,
                    weight: 2.5,
                    dashArray: '2, 7',
                    opacity: 0.72,
                    className: 'alternative-walk-line'
                });
                var altTargetLabel = gf.estimatedTargetHouse ? `<br>Doel: <b>${gf.estimatedTargetHouse}</b>` : '';
                altLine.bindPopup(`<b>🛤️ Alternatieve parallelroute (${area})</b><br>Mijdt N-wegen / kiest parallelweg${altTargetLabel}`);
                geofenceLayer.addLayer(altLine);
                activeAlternativeRoutes[area] = altLine;
            }

            if (activeIntersectionDots[area]) {
                geofenceLayer.removeLayer(activeIntersectionDots[area]);
                delete activeIntersectionDots[area];
            }
            if (gf.intersectionPoint && Array.isArray(gf.intersectionPoint) && gf.intersectionPoint.length === 2) {
                var dotHtml = `<div class="fox-intersection-dot" style="background-color: ${routeAreaColor};"></div>`;
                var dotIcon = L.divIcon({
                    className: 'fox-intersection-wrapper',
                    html: dotHtml,
                    iconSize: [12, 12],
                    iconAnchor: [6, 6],
                    popupAnchor: [0, -6]
                });
                var dotMarker = L.marker(gf.intersectionPoint, { icon: dotIcon });
                var targetName = gf.estimatedTargetHouse || "onbezochte locatie";
                dotMarker.bindTooltip(`⭕ Cirkel-kruispunt ${area}`, {
                    permanent: false,
                    direction: 'top',
                    className: 'marker-label'
                });
                dotMarker.bindPopup(`
                    <div style="font-size:12px; min-width:185px;">
                        <b>⭕ Kruispunt Cirkel & Route (${area})</b><br>
                        Doelroute: <b>${targetName}</b><br>
                        <button onclick="window.navigateToAreaPoint(${gf.intersectionPoint[0]}, ${gf.intersectionPoint[1]})" style="background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; width:100%; margin-top:6px; font-weight:bold;">
                            📍 Navigeer naar dit kruispunt
                        </button>
                    </div>
                `);
                geofenceLayer.addLayer(dotMarker);
                activeIntersectionDots[area] = dotMarker;
            }

            if (activeLiveExpectedFoxMarkers[area]) {
                geofenceLayer.removeLayer(activeLiveExpectedFoxMarkers[area]);
                delete activeLiveExpectedFoxMarkers[area];
            }
            if (gf.liveExpectedFoxPoint && gf.liveExpectedFoxPoint.coord && Array.isArray(gf.liveExpectedFoxPoint.coord)) {
                var livePt = gf.liveExpectedFoxPoint;
                var walkedDistStr = livePt.distanceMeters >= 1000
                    ? (livePt.distanceMeters / 1000).toFixed(2) + ' km'
                    : livePt.distanceMeters + ' m';

                var liveFoxHtml = `
                    <div class="fox-live-route-marker" style="background-color: ${routeAreaColor};">
                        <span class="fox-live-route-pulse" style="border-color: ${routeAreaColor};"></span>
                    </div>
                `;
                var liveFoxIcon = L.divIcon({
                    className: 'fox-live-route-wrapper',
                    html: liveFoxHtml,
                    iconSize: [18, 18],
                    iconAnchor: [9, 9],
                    popupAnchor: [0, -9]
                });

                var liveFoxMarker = L.marker(livePt.coord, { icon: liveFoxIcon });
                var lockBadge = livePt.isLocked ? '🔒 ' : '';
                var nextClubText = livePt.targetHouse ? ` richting ${lockBadge}${livePt.targetHouse}` : '';
                liveFoxMarker.bindTooltip(`🦊 Verwachte vos ${area}: op ${walkedDistStr}${nextClubText}`, {
                    permanent: false,
                    direction: 'top',
                    className: 'marker-label'
                });
                liveFoxMarker.bindPopup(`
                    <div style="font-size:12px; min-width:200px;">
                        <b>🦊 Live Verwachte Positie (${area})</b><br>
                        Afgelegd over looplijn: <b>${walkedDistStr}</b><br>
                        ${livePt.speedText ? `Snelheid: <b style="color:#2ecc71;">${livePt.speedText}</b><br>` : ''}
                        ${livePt.targetHouse ? `Doel-clubhuis: <b>${lockBadge}${livePt.targetHouse}</b><br>` : ''}
                        ${livePt.visitedOriginHouse ? `Laatst bezocht: <b>${livePt.visitedOriginHouse}</b><br>` : ''}
                        <button onclick="window.navigateToAreaPoint(${livePt.coord[0]}, ${livePt.coord[1]})" style="background:#27ae60; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; width:100%; margin-top:6px; font-weight:bold;">
                            📍 Navigeer naar verwachte vos
                        </button>
                    </div>
                `);
                geofenceLayer.addLayer(liveFoxMarker);
                activeLiveExpectedFoxMarkers[area] = liveFoxMarker;
            }

            if (activeAltExpectedFoxMarkers[area]) {
                geofenceLayer.removeLayer(activeAltExpectedFoxMarkers[area]);
                delete activeAltExpectedFoxMarkers[area];
            }
            if (gf.altLiveExpectedFoxPoint && gf.altLiveExpectedFoxPoint.coord && Array.isArray(gf.altLiveExpectedFoxPoint.coord)) {
                var altPt = gf.altLiveExpectedFoxPoint;
                var altDistStr = altPt.distanceMeters >= 1000
                    ? (altPt.distanceMeters / 1000).toFixed(2) + ' km'
                    : altPt.distanceMeters + ' m';

                var altDotHtml = `<div class="fox-alt-route-marker" style="background-color: ${routeAreaColor};"></div>`;
                var altDotIcon = L.divIcon({
                    className: 'fox-alt-route-wrapper',
                    html: altDotHtml,
                    iconSize: [13, 13],
                    iconAnchor: [6, 6],
                    popupAnchor: [0, -6]
                });

                var altMarker = L.marker(altPt.coord, { icon: altDotIcon });
                altMarker.bindTooltip(`🛤️ Parallel-positie ${area} (${altDistStr})`, {
                    permanent: false,
                    direction: 'top',
                    className: 'marker-label'
                });
                altMarker.bindPopup(`
                    <div style="font-size:12px; min-width:190px;">
                        <b>🛤️ Alternatieve Positie (${area})</b><br>
                        Parallelroute (mijdt N-wegen)<br>
                        Afgelegd: <b>${altDistStr}</b><br>
                        <button onclick="window.navigateToAreaPoint(${altPt.coord[0]}, ${altPt.coord[1]})" style="background:#3498db; color:white; border:none; padding:5px 8px; border-radius:3px; cursor:pointer; width:100%; margin-top:6px; font-weight:bold;">
                            📍 Navigeer naar parallel-punt
                        </button>
                    </div>
                `);
                geofenceLayer.addLayer(altMarker);
                activeAltExpectedFoxMarkers[area] = altMarker;
            }
        }
    });

    targetAreas.forEach(function (areaName) {
        if (!latestKnownAreaPoints[areaName]) {
            var fallbackClub = getFallbackLatestVisitedHouseForArea(areaName);
            if (fallbackClub) {
                latestKnownAreaPoints[areaName] = fallbackClub;
            }
        }
    });

    renderLiveUsersOnMap();
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

/* --- LIVE GEBRUIKERS & HUNTERS OP DE KAART (VERSNELD NAAR 10 SEC) --- */
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

function renderLiveUsersOnMap() {
    var users = cachedUsersData;
    var now = Date.now();

    if (!users || Object.keys(users).length === 0) {
        usersLiveLayer.clearLayers();
        liveUserMarkers = {};
        return;
    }

    Object.keys(users).forEach(function (userId) {
        var u = users[userId];
        if (!u || !u.lat || !u.lng) return;

        if (u.hiddenByAdmin && (!u.lastSeen || u.lastSeen <= (u.hiddenAt || 0))) {
            if (liveUserMarkers[userId]) {
                usersLiveLayer.removeLayer(liveUserMarkers[userId]);
                delete liveUserMarkers[userId];
            }
            return;
        }

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
                var typePrefix = pt.isHouse ? "🏠 Laatste punt (Club)" : "🎯 Laatste punt (RD)";
                vossenOptions += `<option value="${pt.latlng[0]},${pt.latlng[1]}">${typePrefix}: ${areaName} (${dist} km - ~${eta} min)</option>`;
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
}

db.ref('liveUsers').on('value', function (snapshot) {
    cachedUsersData = snapshot.val() || {};
    renderLiveUsersOnMap();
    window.updateFoxFixedDetailCard();
});

// Versneld van 20 seconden naar 10 seconden
setInterval(renderLiveUsersOnMap, 10000);

/* ==========================================================================
   VOSSEN STATUS MENU MET VAST INFO-VENSTER (100% FLIKKERVRIJ)
   ========================================================================== */

var selectedFoxInfoArea = null;
var singleClickFoxTimerByArea = {};
var lastFoxTapTimeByArea = {};
var MAX_STATUS_TIMER_SECONDS = 12 * 3600; // Maximaal 12 uur tellen

function injectFoxStatusPanel() {
    var mapWrapper = document.getElementById('map-wrapper');
    if (!mapWrapper || document.getElementById('fox-status-panel')) return;

    var panel = document.createElement('div');
    panel.id = 'fox-status-panel';
    panel.innerHTML = `
        <div id="fox-status-header">
            <span>🦊 Vossen Status</span>
            <button type="button" id="fox-status-min-btn" title="Minimaliseren / Maximaliseren">-</button>
        </div>
        <div id="fox-status-body">
            <div id="fox-status-buttons-list"></div>
        </div>
    `;
    mapWrapper.appendChild(panel);

    // VAST LOSSTAAND INFO-VENSTER (zodat knoppen nooit meer verspringen of flikkeren)
    var detailCard = document.createElement('div');
    detailCard.id = 'fox-fixed-detail-card';
    detailCard.style.display = 'none';
    detailCard.innerHTML = `
        <div id="fox-detail-header">
            <div style="display:flex; align-items:center; gap:7px;">
                <span id="fox-detail-color-dot"></span>
                <span id="fox-detail-title">Deelgebied</span>
            </div>
            <button type="button" id="fox-detail-close-btn" title="Sluiten">✕</button>
        </div>
        <div id="fox-detail-body">
            <div class="fox-info-row">
                <span class="fox-info-label" id="fox-detail-status-label">⏱️ Op status:</span>
                <span class="fox-info-val" id="fox-detail-timer-val" data-updated-at="">--</span>
            </div>
            <div class="fox-info-row">
                <span class="fox-info-label">🚗 Jouw afstand & reistijd:</span>
                <span class="fox-info-val" id="fox-detail-my-travel">--</span>
            </div>
            <div class="fox-info-row">
                <span class="fox-info-label">🥇 Dichtstbijzijnde hunter:</span>
                <span class="fox-info-val" id="fox-detail-closest-hunter">--</span>
            </div>
            <div class="fox-detail-actions">
                <button type="button" id="fox-detail-zoom-btn" class="fox-info-zoom-btn">
                    🔍 Zoom op kaart
                </button>
                <button type="button" id="fox-detail-nav-btn" class="fox-info-nav-btn" style="display:none;">
                    📍 Navigeer naar schatting
                </button>
            </div>
        </div>
    `;
    mapWrapper.appendChild(detailCard);

    if (typeof L !== 'undefined' && L.DomEvent) {
        L.DomEvent.disableClickPropagation(panel);
        L.DomEvent.disableScrollPropagation(panel);
        L.DomEvent.disableClickPropagation(detailCard);
        L.DomEvent.disableScrollPropagation(detailCard);
    }

    document.getElementById('fox-detail-close-btn').addEventListener('click', function() {
        selectedFoxInfoArea = null;
        window.renderFoxStatusButtons();
    });

    var minBtn = document.getElementById('fox-status-min-btn');
    var bodyEl = document.getElementById('fox-status-body');
    minBtn.addEventListener('click', function() {
        if (bodyEl.style.display === 'none') {
            bodyEl.style.display = 'flex';
            minBtn.innerText = '-';
        } else {
            bodyEl.style.display = 'none';
            minBtn.innerText = '+';
        }
    });

    var headerEl = document.getElementById('fox-status-header');
    var isDraggingFoxPanel = false, dragStartX = 0, dragStartY = 0;

    headerEl.addEventListener('mousedown', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        isDraggingFoxPanel = true;
        dragStartX = e.clientX - panel.offsetLeft;
        dragStartY = e.clientY - panel.offsetTop;
        document.addEventListener('mousemove', onFoxMouseMove);
        document.addEventListener('mouseup', onFoxMouseUp);
    });

    headerEl.addEventListener('touchstart', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        isDraggingFoxPanel = true;
        var touch = e.touches[0];
        dragStartX = touch.clientX - panel.offsetLeft;
        dragStartY = touch.clientY - panel.offsetTop;
        document.addEventListener('touchmove', onFoxTouchMove, { passive: false });
        document.addEventListener('touchend', onFoxTouchEnd);
    });

    function moveFoxPanel(clientX, clientY) {
        var maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
        var maxY = Math.max(0, mapWrapper.clientHeight - panel.offsetHeight);
        var newX = Math.max(0, Math.min(clientX - dragStartX, maxX));
        var newY = Math.max(0, Math.min(clientY - dragStartY, maxY));
        panel.style.left = newX + 'px';
        panel.style.top = newY + 'px';
        panel.style.right = 'auto';
        positionFoxDetailCard();
    }

    function onFoxMouseMove(e) {
        if (isDraggingFoxPanel) moveFoxPanel(e.clientX, e.clientY);
    }
    function onFoxTouchMove(e) {
        if (isDraggingFoxPanel) {
            e.preventDefault();
            moveFoxPanel(e.touches[0].clientX, e.touches[0].clientY);
        }
    }
    function onFoxMouseUp() {
        isDraggingFoxPanel = false;
        document.removeEventListener('mousemove', onFoxMouseMove);
        document.removeEventListener('mouseup', onFoxMouseUp);
    }
    function onFoxTouchEnd() {
        isDraggingFoxPanel = false;
        document.removeEventListener('touchmove', onFoxTouchMove);
        document.removeEventListener('touchend', onFoxTouchEnd);
    }

    window.addEventListener('resize', positionFoxDetailCard);
    renderFoxStatusButtons();
}

/* Positioneert het vaste info-venster netjes links (of rechts) naast het Vossen Status paneel */
function positionFoxDetailCard() {
    var panel = document.getElementById('fox-status-panel');
    var card = document.getElementById('fox-fixed-detail-card');
    if (!panel || !card || card.style.display === 'none') return;

    var panelRect = panel.getBoundingClientRect();
    var wrapperEl = document.getElementById('map-wrapper');
    var wrapRect = wrapperEl ? wrapperEl.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

    var cardWidth = 235;
    var leftCandidate = (panelRect.left - wrapRect.left) - cardWidth - 8;
    var rightCandidate = (panelRect.right - wrapRect.left) + 8;

    if (leftCandidate >= 8) {
        card.style.left = leftCandidate + 'px';
        card.style.right = 'auto';
        card.style.top = Math.max(8, (panelRect.top - wrapRect.top)) + 'px';
    } else if (rightCandidate + cardWidth <= wrapRect.width - 8) {
        card.style.left = rightCandidate + 'px';
        card.style.right = 'auto';
        card.style.top = Math.max(8, (panelRect.top - wrapRect.top)) + 'px';
    } else {
        // Op smalle telefoonschermen: strak linksboven/middenboven naast het paneel of eronder
        card.style.left = Math.max(8, wrapRect.width - cardWidth - 12) + 'px';
        card.style.right = 'auto';
        card.style.top = Math.min(wrapRect.height - 210, (panelRect.bottom - wrapRect.top) + 6) + 'px';
    }
}

window.zoomToLatestFoxArea = function(areaName) {
    var targetPt = latestKnownAreaPoints[areaName] || getFallbackLatestVisitedHouseForArea(areaName);

    if (targetPt && targetPt.latlng) {
        map.flyTo(targetPt.latlng, 15, { animate: true, duration: 1.0 });
        if (targetPt.marker) {
            setTimeout(function() {
                targetPt.marker.openPopup();
            }, 650);
        }
    } else {
        alert("Nog geen bekend punt (RD-punt of bezochte club) voor deelgebied " + areaName + ".");
    }
};

window.handleFoxAreaBtnClick = function(areaName) {
    var now = Date.now();
    var lastTap = lastFoxTapTimeByArea[areaName] || 0;

    if (now - lastTap < 340) {
        lastFoxTapTimeByArea[areaName] = 0;
        if (singleClickFoxTimerByArea[areaName]) {
            clearTimeout(singleClickFoxTimerByArea[areaName]);
            delete singleClickFoxTimerByArea[areaName];
        }
        window.zoomToLatestFoxArea(areaName);
    } else {
        lastFoxTapTimeByArea[areaName] = now;
        if (singleClickFoxTimerByArea[areaName]) {
            clearTimeout(singleClickFoxTimerByArea[areaName]);
        }
        singleClickFoxTimerByArea[areaName] = setTimeout(function() {
            delete singleClickFoxTimerByArea[areaName];
            if (selectedFoxInfoArea === areaName) {
                selectedFoxInfoArea = null;
            } else {
                selectedFoxInfoArea = areaName;
            }
            window.renderFoxStatusButtons();
        }, 240);
    }
};

function formatLiveStatusTimer(updatedAtMs, fallbackText) {
    if (!updatedAtMs || isNaN(updatedAtMs)) {
        return fallbackText || "Onbekend";
    }
    var diffSec = Math.max(0, Math.floor((Date.now() - Number(updatedAtMs)) / 1000));
    if (diffSec >= MAX_STATUS_TIMER_SECONDS) {
        return "12u 00m 00s (max 12u)";
    }
    var hours = Math.floor(diffSec / 3600);
    var mins = Math.floor((diffSec % 3600) / 60);
    var secs = diffSec % 60;
    var mmStr = String(mins).padStart(2, '0');
    var ssStr = String(secs).padStart(2, '0');
    if (hours > 0) {
        return `${hours}u ${mmStr}m ${ssStr}s`;
    }
    return `${mins}m ${ssStr}s`;
}

function getFoxStatusInfoBoxData(areaName, colorKey, cfg, stObj) {
    var masterMetrics = (lastComputedMapState && lastComputedMapState.foxStatusMetrics && lastComputedMapState.foxStatusMetrics[areaName])
        ? lastComputedMapState.foxStatusMetrics[areaName]
        : null;

    var statusUpdatedAt = (masterMetrics && masterMetrics.statusUpdatedAt) ? masterMetrics.statusUpdatedAt : (stObj.updatedAt || null);
    if (!statusUpdatedAt && stObj.timeFormatted && stObj.timeFormatted.includes(':')) {
        var tParts = stObj.timeFormatted.split(':');
        var dTemp = new Date();
        dTemp.setHours(parseInt(tParts[0], 10) || 0, parseInt(tParts[1], 10) || 0, 0, 0);
        if (dTemp.getTime() > Date.now()) dTemp.setDate(dTemp.getDate() - 1);
        statusUpdatedAt = dTemp.getTime();
    }

    var timerStr = formatLiveStatusTimer(statusUpdatedAt, masterMetrics ? masterMetrics.statusDurationText : "");
    var sinceStr = stObj.timeFormatted ? ` (sinds ${stObj.timeFormatted})` : '';
    var statusTitleText = `⏱️ Op status ${cfg.label}${sinceStr}:`;

    var myTravelHtml = `<span style="color:#95a5a6;">Wachten op jouw GPS / vossenpunt...</span>`;
    if (masterMetrics && masterMetrics.estimatedCoord) {
        if (currentUserId && masterMetrics.userRoutes && masterMetrics.userRoutes[currentUserId]) {
            var myRoute = masterMetrics.userRoutes[currentUserId];
            myTravelHtml = `<b style="color:#2ecc71;">${myRoute.distKm} km</b> over de weg • <b style="color:#2ecc71;">~${myRoute.durationMin} min</b>`;
        } else if (isAdmin && (!currentUserId || !masterMetrics.userRoutes || !masterMetrics.userRoutes[currentUserId])) {
            myTravelHtml = `<span style="color:#bdc3c7;">Admin-sessie (geen eigen veld-GPS actief)</span>`;
        } else {
            myTravelHtml = `<span style="color:#f39c12;">Wordt berekend door Master Engine...</span>`;
        }
    } else {
        myTravelHtml = `<span style="color:#95a5a6;">Nog geen vossenlocatie bekend</span>`;
    }

    var closestUserHtml = `<span style="color:#95a5a6;">Geen online hunter in de buurt</span>`;
    if (masterMetrics && masterMetrics.estimatedCoord) {
        if (masterMetrics.closestOnlineUser && masterMetrics.closestOnlineUser.name) {
            var cUser = masterMetrics.closestOnlineUser;
            closestUserHtml = `<b style="color:#5dade2;">🚗 ${cUser.name}</b> (${cUser.distKm} km • ~${cUser.durationMin} min)`;
        } else {
            closestUserHtml = `<span style="color:#95a5a6;">Geen actieve online hunters</span>`;
        }
    } else {
        closestUserHtml = `<span style="color:#95a5a6;">Nog geen vossenlocatie bekend</span>`;
    }

    var hasCoord = !!(masterMetrics && Array.isArray(masterMetrics.estimatedCoord) && masterMetrics.estimatedCoord.length === 2);
    var cLat = hasCoord ? masterMetrics.estimatedCoord[0] : null;
    var cLng = hasCoord ? masterMetrics.estimatedCoord[1] : null;

    return {
        statusTitleText: statusTitleText,
        statusUpdatedAt: statusUpdatedAt || '',
        timerStr: timerStr,
        myTravelHtml: myTravelHtml,
        closestUserHtml: closestUserHtml,
        hasCoord: hasCoord,
        cLat: cLat,
        cLng: cLng,
        borderColor: cfg.bg
    };
}

/* Updatet het vaste detail-venster in-place (zonder enige DOM-herbouw) */
window.updateFoxFixedDetailCard = function() {
    var card = document.getElementById('fox-fixed-detail-card');
    if (!card) return;

    if (!selectedFoxInfoArea) {
        if (card.style.display !== 'none') card.style.display = 'none';
        return;
    }

    var areaName = selectedFoxInfoArea;
    var stObj = currentFoxStatuses[areaName] || {};
    var colorKey = stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";
    var cfg = foxStatusConfig[colorKey] || foxStatusConfig["grijs"];

    var infoData = getFoxStatusInfoBoxData(areaName, colorKey, cfg, stObj);

    if (card.style.display === 'none') {
        card.style.display = 'flex';
        positionFoxDetailCard();
    }

    card.style.borderTop = `4px solid ${cfg.bg}`;

    var dotEl = document.getElementById('fox-detail-color-dot');
    if (dotEl) dotEl.style.backgroundColor = cfg.bg;

    var titleEl = document.getElementById('fox-detail-title');
    var expectedTitle = `${areaName} (${cfg.label})`;
    if (titleEl && titleEl.textContent !== expectedTitle) {
        titleEl.textContent = expectedTitle;
    }

    var statusLabelEl = document.getElementById('fox-detail-status-label');
    if (statusLabelEl && statusLabelEl.textContent !== infoData.statusTitleText) {
        statusLabelEl.textContent = infoData.statusTitleText;
    }

    var timerValEl = document.getElementById('fox-detail-timer-val');
    if (timerValEl) {
        timerValEl.setAttribute('data-updated-at', String(infoData.statusUpdatedAt));
        if (timerValEl.textContent !== infoData.timerStr) {
            timerValEl.textContent = infoData.timerStr;
        }
    }

    var myTravelEl = document.getElementById('fox-detail-my-travel');
    if (myTravelEl && myTravelEl._lastHtml !== infoData.myTravelHtml) {
        myTravelEl.innerHTML = infoData.myTravelHtml;
        myTravelEl._lastHtml = infoData.myTravelHtml;
    }

    var closestEl = document.getElementById('fox-detail-closest-hunter');
    if (closestEl && closestEl._lastHtml !== infoData.closestUserHtml) {
        closestEl.innerHTML = infoData.closestUserHtml;
        closestEl._lastHtml = infoData.closestUserHtml;
    }

    var zoomBtn = document.getElementById('fox-detail-zoom-btn');
    if (zoomBtn) {
        zoomBtn.onclick = function() {
            window.zoomToLatestFoxArea(areaName);
        };
    }

    var navBtn = document.getElementById('fox-detail-nav-btn');
    if (navBtn) {
        if (infoData.hasCoord) {
            navBtn.style.display = 'block';
            navBtn.onclick = function() {
                window.navigateToAreaPoint(infoData.cLat, infoData.cLng);
            };
        } else {
            navBtn.style.display = 'none';
        }
    }
};

/* Rendert de vossen-knoppen 100% flikkervrij (geen appendChild op bestaande knoppen!) */
window.renderFoxStatusButtons = function() {
    var listEl = document.getElementById('fox-status-buttons-list');
    if (!listEl) return;

    var visibleAreas = targetAreas.filter(function(areaName) {
        var stObj = currentFoxStatuses[areaName];
        var colorKey = stObj && stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";
        return visibleFoxStatusColors[colorKey] !== false;
    });

    if (visibleAreas.length === 0) {
        listEl.innerHTML = `<div class="fox-status-empty">Geen statussen geselecteerd</div>`;
        selectedFoxInfoArea = null;
        window.updateFoxFixedDetailCard();
        return;
    }

    var emptyMsg = listEl.querySelector('.fox-status-empty');
    if (emptyMsg) emptyMsg.remove();

    // Bouw de knoppen éénmalig in vaste volgorde voor alle targetAreas en verberg alleen wat gefilterd is
    targetAreas.forEach(function(areaName) {
        var wrapEl = listEl.querySelector(`.fox-area-status-item-wrap[data-area="${areaName}"]`);
        if (!wrapEl) {
            wrapEl = document.createElement('div');
            wrapEl.className = 'fox-area-status-item-wrap';
            wrapEl.setAttribute('data-area', areaName);
            wrapEl.innerHTML = `
                <button type="button"
                    class="fox-area-status-btn"
                    onclick="window.handleFoxAreaBtnClick('${areaName}')"
                    title="1x klikken: Open vast info-venster • Dubbelklik: Zoom in op laatste punt">
                    <span class="fox-btn-name">${areaName}</span>
                </button>
            `;
            listEl.appendChild(wrapEl);
        }

        var isVisible = visibleAreas.includes(areaName);
        var desiredDisplay = isVisible ? 'flex' : 'none';
        if (wrapEl.style.display !== desiredDisplay) {
            wrapEl.style.display = desiredDisplay;
        }

        if (!isVisible && selectedFoxInfoArea === areaName) {
            selectedFoxInfoArea = null;
        }

        var stObj = currentFoxStatuses[areaName] || {};
        var colorKey = stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";
        var cfg = foxStatusConfig[colorKey] || foxStatusConfig["grijs"];
        var isSelected = (selectedFoxInfoArea === areaName);

        var btnEl = wrapEl.querySelector('.fox-area-status-btn');
        if (btnEl) {
            var nextClass = `fox-area-status-btn status-color-${colorKey}` + (isSelected ? ' is-selected-area' : '');
            if (btnEl.className !== nextClass) btnEl.className = nextClass;
            if (btnEl.style.backgroundColor !== cfg.bg) btnEl.style.backgroundColor = cfg.bg;
            if (btnEl.style.borderColor !== cfg.border) btnEl.style.borderColor = cfg.border;
            if (btnEl.style.color !== cfg.text) btnEl.style.color = cfg.text;
        }
    });

    window.updateFoxFixedDetailCard();
};

// Update elke seconde alleen de tekst van de status-timer in het vaste venster
setInterval(function() {
    if (!selectedFoxInfoArea) return;
    var timerEl = document.getElementById('fox-detail-timer-val');
    if (timerEl) {
        var ts = parseInt(timerEl.getAttribute('data-updated-at'), 10);
        if (ts && !isNaN(ts)) {
            var nextText = formatLiveStatusTimer(ts, "");
            if (timerEl.textContent !== nextText) {
                timerEl.textContent = nextText;
            }
        }
    }
}, 1000);

injectFoxStatusPanel();

/* ==========================================================================
   DUIDELIJKE IN-APP MELDING BIJ VOSSEN OP GROEN ("WEER GEHUNT MAG WORDEN")
   ========================================================================== */

var greenAlertTimeout = null;

function ensureGreenHuntBannerUI() {
    if (document.getElementById('green-hunt-alert-toast')) return;
    var mapWrapper = document.getElementById('map-wrapper') || document.body;
    var toast = document.createElement('div');
    toast.id = 'green-hunt-alert-toast';
    toast.style.display = 'none';
    toast.innerHTML = `
        <div class="green-hunt-toast-content">
            <div class="green-hunt-toast-icon">🟢🦊</div>
            <div class="green-hunt-toast-text">
                <div id="green-hunt-toast-title">DEELGEBIED MAG WEER GEHUNT WORDEN!</div>
                <div id="green-hunt-toast-sub">Status is zojuist op GROEN gesprongen!</div>
            </div>
            <div class="green-hunt-toast-actions">
                <button type="button" id="green-hunt-toast-zoom-btn">🎯 Zoom in</button>
                <button type="button" id="green-hunt-toast-close-btn">✕</button>
            </div>
        </div>
    `;
    mapWrapper.appendChild(toast);

    document.getElementById('green-hunt-toast-close-btn').addEventListener('click', function() {
        toast.style.display = 'none';
    });
}

function triggerAreaHuntableAlert(areaName, timeFormatted) {
    ensureGreenHuntBannerUI();
    playAlertSound('green');
    if ('vibrate' in navigator) navigator.vibrate([400, 120, 400, 120, 600]);

    var toast = document.getElementById('green-hunt-alert-toast');
    var titleEl = document.getElementById('green-hunt-toast-title');
    var subEl = document.getElementById('green-hunt-toast-sub');
    var zoomBtn = document.getElementById('green-hunt-toast-zoom-btn');

    var timePart = timeFormatted ? ` (om ${timeFormatted})` : '';
    titleEl.textContent = `🟢 ${areaName.toUpperCase()} MAG WEER GEHUNT WORDEN!`;
    subEl.textContent = `Deelgebied ${areaName} staat weer op GROEN${timePart}. Ga direct op pad!`;

    zoomBtn.onclick = function() {
        window.zoomToLatestFoxArea(areaName);
        selectedFoxInfoArea = areaName;
        window.renderFoxStatusButtons();
        toast.style.display = 'none';
    };

    toast.style.display = 'block';
    if (greenAlertTimeout) clearTimeout(greenAlertTimeout);
    greenAlertTimeout = setTimeout(function() {
        toast.style.display = 'none';
    }, 18000);
}

// 1. Luister real-time naar statuswijzigingen vanuit Telegram in Firebase ('foxStatuses')
var isInitialFoxStatusLoad = true;
var prevFoxStatusMap = {};

db.ref('foxStatuses').on('value', function(snapshot) {
    var data = snapshot.val() || {};
    currentFoxStatuses = data;
    window.renderFoxStatusButtons();

    targetAreas.forEach(function(areaName) {
        var stObj = data[areaName] || {};
        var curr = stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";

        if (!isInitialFoxStatusLoad && prevFoxStatusMap[areaName] && prevFoxStatusMap[areaName] !== curr) {
            var cfg = foxStatusConfig[curr] || foxStatusConfig["grijs"];

            // EXTRA DUIDELIJKE IN-APP MELDING ALS DEELGEBIED WEER GEHUNT MAG WORDEN (GROEN)
            if (curr === "groen") {
                triggerAreaHuntableAlert(areaName, stObj.timeFormatted || "");
            } else {
                if ('vibrate' in navigator) navigator.vibrate([250, 100, 250]);
            }

            if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
                navigator.serviceWorker.ready.then(function(reg) {
                    var notifTitle = curr === "groen"
                        ? `🟢 JA! ${areaName} mag weer gehunt worden!`
                        : `🦊 Status ${areaName}: ${cfg.label}`;
                    var notifBody = curr === "groen"
                        ? `Deelgebied ${areaName} staat weer op GROEN! Klik om op de kaart te kijken.`
                        : `Status van ${areaName} is via Telegram gewijzigd in ${cfg.label}!`;

                    reg.showNotification(notifTitle, {
                        body: notifBody,
                        icon: 'icon-192.png',
                        badge: 'icon-192.png',
                        vibrate: curr === "groen" ? [400, 120, 400, 120, 600] : [250, 100, 250],
                        tag: 'fox-status-' + areaName,
                        renotify: true
                    });
                });
            }
        }
        prevFoxStatusMap[areaName] = curr;
    });
    isInitialFoxStatusLoad = false;
});

// 2. Luister real-time naar de ingestelde status-filters vanuit het Beheer Instellingen menu
db.ref('adminSettings/visibleFoxStatuses').on('value', function(snapshot) {
    var val = snapshot.val();
    if (val && typeof val === 'object') {
        Object.keys(foxStatusConfig).forEach(function(k) {
            visibleFoxStatusColors[k] = (val[k] !== false);
        });
    } else {
        Object.keys(foxStatusConfig).forEach(function(k) {
            visibleFoxStatusColors[k] = true;
        });
    }
    window.renderFoxStatusButtons();
    if (typeof window.syncAdminFoxFilterCheckboxes === 'function') {
        window.syncAdminFoxFilterCheckboxes();
    }
});

/* ==========================================================================
   MEGA BELANGRIJKE MELDING: TEGENHUNT POPUP MIDDEN OP HET SCHERM + AUTO-ZOOM
   ========================================================================== */

var currentCounterHuntData = null;
var counterHuntCountdownInterval = null;
var lastHandledCounterHuntId = null;

function getBearingFromDirectionName(dirName) {
    var d = String(dirName || "").toLowerCase().replace(/[\s\-_]/g, "");
    var mapBearings = {
        "noord": 0, "n": 0,
        "noordoost": 45, "no": 45,
        "oost": 90, "o": 90,
        "zuidoost": 135, "zo": 135,
        "zuid": 180, "z": 180,
        "zuidwest": 225, "zw": 225,
        "west": 270, "w": 270,
        "noordwest": 315, "nw": 315
    };
    return mapBearings[d] !== undefined ? mapBearings[d] : null;
}

function computeDestLatLngSimple(lat, lng, distMeters, bearingDeg) {
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

/* Tekent op de kaart bij Scouting Amalgama een opvallende rode windrichting-sector (taartpunt) binnen de 450m cirkel */
function renderCounterHuntSectorOnMap(chData) {
    counterHuntHighlightLayer.clearLayers();
    if (!chData || chData.state !== 'active') {
        amalgamaBaseCircle.setStyle({ color: '#e67e22', fillColor: '#e67e22', weight: 2 });
        return;
    }

    amalgamaBaseCircle.setStyle({ color: '#ff2e2e', fillColor: '#e74c3c', weight: 3.5 });

    var bearing = getBearingFromDirectionName(chData.direction);
    if (bearing !== null) {
        var wedgePoints = [[amalgamaLat, amalgamaLng]];
        for (var a = bearing - 28; a <= bearing + 28; a += 4) {
            var normA = (a + 360) % 360;
            wedgePoints.push(computeDestLatLngSimple(amalgamaLat, amalgamaLng, radiusMeters, normA));
        }
        wedgePoints.push([amalgamaLat, amalgamaLng]);

        var sectorPoly = L.polygon(wedgePoints, {
            color: '#ff0000',
            weight: 3,
            fillColor: '#ff0000',
            fillOpacity: 0.35,
            dashArray: '6, 4'
        }).addTo(counterHuntHighlightLayer);

        sectorPoly.bindTooltip(`🚨 TEGENHUNT RICHTING: ${String(chData.direction).toUpperCase()}`, {
            permanent: true,
            direction: 'center',
            className: 'marker-label user-gps-label-inactive'
        });
    }
}

function injectCounterHuntUI() {
    if (document.getElementById('counterhunt-modal-overlay')) return;

    // 1. Centrale Popup Midden op het scherm
    var overlay = document.createElement('div');
    overlay.id = 'counterhunt-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div id="counterhunt-modal-box" class="ch-mode-active">
            <div id="ch-top-timer-wrap">
                <div id="ch-timer-caption">⏳ RESTERENDE ZOEKTIJD (30 MIN)</div>
                <div id="ch-giant-timer">30:00</div>
            </div>

            <div id="ch-alert-badge">🚨 TEGENHUNT GEPLAKT BIJ CLUBGEBOUW! 🚨</div>

            <div id="ch-main-info-grid">
                <div class="ch-info-card">
                    <span class="ch-info-card-label">🧭 WINDRICHTING</span>
                    <span class="ch-info-card-val" id="ch-direction-val">Zuid-West</span>
                </div>
                <div class="ch-info-card">
                    <span class="ch-info-card-label">🕒 GEPLAKT OM TIJDSTIP</span>
                    <span class="ch-info-card-val" id="ch-time-val">23:01</span>
                </div>
            </div>

            <div id="ch-extra-details">
                Inzet: <b id="ch-points-val">10 punten</b> • Zoek binnen de <b>450m cirkel</b> van <b>Scouting Amalgama</b>!
            </div>

            <div id="ch-raw-msg-box"></div>

            <div class="ch-modal-actions">
                <button type="button" id="ch-btn-zoom-club" class="ch-action-btn ch-btn-primary">
                    🗺️ Bekijk op Kaart (Scouting Amalgama)
                </button>
                <button type="button" id="ch-btn-nav-club" class="ch-action-btn ch-btn-secondary">
                    📍 Navigeer naar Clubgebouw
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // 2. Klikbare Mini-Balk bovenin het scherm (zichtbaar als de popup even weggeklikt is terwijl de timer nog loopt)
    var mapWrapper = document.getElementById('map-wrapper') || document.body;
    var miniBar = document.createElement('div');
    miniBar.id = 'counterhunt-mini-bar';
    miniBar.style.display = 'none';
    miniBar.innerHTML = `
        <span id="ch-mini-text">🚨 TEGENHUNT ACTIEF (Zuid-West) • Geplakt: 23:01</span>
        <span id="ch-mini-timer">30:00</span>
        <span class="ch-mini-open-btn">Open Popup 🔼</span>
    `;
    mapWrapper.appendChild(miniBar);

    document.getElementById('ch-btn-zoom-club').addEventListener('click', function() {
        overlay.style.display = 'none';
        map.flyTo([amalgamaLat, amalgamaLng], 16, { animate: true, duration: 1.0 });
        updateCounterHuntMiniBar();
    });

    document.getElementById('ch-btn-nav-club').addEventListener('click', function() {
        window.navigateToAreaPoint(amalgamaLat, amalgamaLng);
    });

    miniBar.addEventListener('click', function() {
        overlay.style.display = 'flex';
        miniBar.style.display = 'none';
    });
}

function formatCounterHuntRemaining(expiresAtMs) {
    var diffSec = Math.floor((Number(expiresAtMs) - Date.now()) / 1000);
    if (diffSec <= 0) return { expired: true, text: "00:00" };
    var mins = Math.floor(diffSec / 60);
    var secs = diffSec % 60;
    return {
        expired: false,
        text: String(mins).padStart(2, '0') + ":" + String(secs).padStart(2, '0')
    };
}

function updateCounterHuntMiniBar() {
    var overlay = document.getElementById('counterhunt-modal-overlay');
    var miniBar = document.getElementById('counterhunt-mini-bar');
    if (!miniBar) return;

    if (!currentCounterHuntData || currentCounterHuntData.state !== 'active') {
        miniBar.style.display = 'none';
        return;
    }

    var rem = formatCounterHuntRemaining(currentCounterHuntData.expiresAtMs);
    if (rem.expired) {
        miniBar.style.display = 'none';
        counterHuntHighlightLayer.clearLayers();
        amalgamaBaseCircle.setStyle({ color: '#e67e22', fillColor: '#e67e22', weight: 2 });
        return;
    }

    var isModalOpen = overlay && overlay.style.display === 'flex';
    miniBar.style.display = isModalOpen ? 'none' : 'flex';

    var miniText = document.getElementById('ch-mini-text');
    var miniTimer = document.getElementById('ch-mini-timer');
    if (miniText) {
        miniText.textContent = `🚨 TEGENHUNT: ${String(currentCounterHuntData.direction || '').toUpperCase()} (Geplakt ${currentCounterHuntData.timeShort || ''})`;
    }
    if (miniTimer) {
        miniTimer.textContent = `⏳ ${rem.text}`;
    }
}

function updateCounterHuntTimersTick() {
    if (!currentCounterHuntData) return;

    if (currentCounterHuntData.state === 'active') {
        var rem = formatCounterHuntRemaining(currentCounterHuntData.expiresAtMs);
        var giantTimer = document.getElementById('ch-giant-timer');
        if (giantTimer) {
            giantTimer.textContent = rem.expired ? "00:00 (VERLOPEN)" : rem.text;
        }
        updateCounterHuntMiniBar();
    }
}

injectCounterHuntUI();
setInterval(updateCounterHuntTimersTick, 1000);

// Luister real-time naar 'counterHunt' in Firebase
var isInitialCounterHuntLoad = true;

db.ref('counterHunt').on('value', function(snapshot) {
    var data = snapshot.val();
    currentCounterHuntData = data;
    injectCounterHuntUI();

    var overlay = document.getElementById('counterhunt-modal-overlay');
    var modalBox = document.getElementById('counterhunt-modal-box');
    var timerWrap = document.getElementById('ch-top-timer-wrap');
    var timerCaption = document.getElementById('ch-timer-caption');
    var giantTimer = document.getElementById('ch-giant-timer');
    var alertBadge = document.getElementById('ch-alert-badge');
    var infoGrid = document.getElementById('ch-main-info-grid');
    var dirVal = document.getElementById('ch-direction-val');
    var timeVal = document.getElementById('ch-time-val');
    var extraDetails = document.getElementById('ch-extra-details');
    var rawMsgBox = document.getElementById('ch-raw-msg-box');
    var zoomBtn = document.getElementById('ch-btn-zoom-club');

    if (!data) {
        overlay.style.display = 'none';
        renderCounterHuntSectorOnMap(null);
        updateCounterHuntMiniBar();
        isInitialCounterHuntLoad = false;
        return;
    }

    var now = Date.now();
    var isNewEvent = (data.id && data.id !== lastHandledCounterHuntId);

    // SITUATIE 1: ACTIEVE TEGENHUNT BINNENGEKOMEN
    if (data.state === 'active') {
        var rem = formatCounterHuntRemaining(data.expiresAtMs);
        if (rem.expired) {
            overlay.style.display = 'none';
            renderCounterHuntSectorOnMap(null);
            updateCounterHuntMiniBar();
            isInitialCounterHuntLoad = false;
            return;
        }

        modalBox.className = 'ch-mode-active';
        timerWrap.style.display = 'flex';
        timerCaption.textContent = '⏳ RESTERENDE TIJD OM TE VINDEN';
        giantTimer.textContent = rem.text;

        alertBadge.textContent = '🚨 TEGENHUNT GEPLAKT BIJ ONS CLUBGEBOUW! 🚨';
        infoGrid.style.display = 'grid';
        dirVal.textContent = data.direction || 'Onbekend';
        timeVal.textContent = data.timeShort || data.timeFull || '--:--';
        extraDetails.innerHTML = `Kost bij niet vinden: <b>${data.points || 10} punten</b> • Zoek binnen 450m van <b>Scouting Amalgama</b>!`;
        rawMsgBox.textContent = data.rawMessage || '';
        zoomBtn.textContent = '🗺️ Sluit & Zoek op Kaart (Scouting Amalgama)';

        renderCounterHuntSectorOnMap(data);

        if (isNewEvent) {
            lastHandledCounterHuntId = data.id;
            overlay.style.display = 'flex';

            // Zoom bij iedere ingelogde gebruiker direct in op ons clubgebouw (Scouting Amalgama)
            map.flyTo([amalgamaLat, amalgamaLng], 16, { animate: true, duration: 1.2 });

            playAlertSound('counterhunt');
            if ('vibrate' in navigator) navigator.vibrate([600, 150, 600, 150, 800]);

            if (!isInitialCounterHuntLoad && 'serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
                navigator.serviceWorker.ready.then(function(reg) {
                    reg.showNotification("🚨 TEGENHUNT GEPLAKT (" + (data.direction || "") + ")!", {
                        body: `Geplakt om ${data.timeShort || ''}! Richting: ${data.direction}. Jullie hebben 30 minuten!`,
                        icon: 'icon-192.png',
                        badge: 'icon-192.png',
                        vibrate: [600, 150, 600, 150, 800],
                        tag: 'counterhunt-alert',
                        renotify: true
                    });
                });
            }
        }
        updateCounterHuntMiniBar();
    }
    // SITUATIE 2: TEGENHUNT VERIJDELD / GEVONDEN!
    else if (data.state === 'foiled') {
        renderCounterHuntSectorOnMap(null);
        updateCounterHuntMiniBar();

        // Toon de Gefeliciteerd-popup als het verijdeld-bericht recent is (< 10 min oud)
        var foiledAgeMs = now - (data.foiledAtMs || 0);
        if (isNewEvent && foiledAgeMs < 10 * 60 * 1000) {
            lastHandledCounterHuntId = data.id;

            modalBox.className = 'ch-mode-foiled';
            timerWrap.style.display = 'flex';
            timerCaption.textContent = '🎉 TEGENHUNT SUCCESVOL VERIJDELD!';
            giantTimer.textContent = `+${data.points || 10} PT`;

            alertBadge.textContent = `🏆 GEFELICITEERD! CODE ${data.code || ''} GEVONDEN!`;
            infoGrid.style.display = 'none';
            extraDetails.innerHTML = `De tegenhunt met code <b>${data.code || ''}</b> is verijdeld! Dit levert jullie <b>${data.points || 10} punten</b> op!`;
            rawMsgBox.textContent = data.rawMessage || '';
            zoomBtn.textContent = '✔️ Top, Sluit Melding';

            overlay.style.display = 'flex';
            playAlertSound('foiled');
            if ('vibrate' in navigator) navigator.vibrate([250, 100, 250, 100, 400]);

            if (!isInitialCounterHuntLoad && 'serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
                navigator.serviceWorker.ready.then(function(reg) {
                    reg.showNotification("🎉 Tegenhunt Verijdeld! (+" + (data.points || 10) + " punten)", {
                        body: `Code ${data.code || ''} is gevonden! Goed gewerkt!`,
                        icon: 'icon-192.png',
                        badge: 'icon-192.png',
                        tag: 'counterhunt-alert',
                        renotify: true
                    });
                });
            }
        }
    }

    isInitialCounterHuntLoad = false;
});