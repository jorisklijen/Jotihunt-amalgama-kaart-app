/* ==========================================================================
   3A. MAP-VIEWER.JS - KAARTWEERGAVE, CLUBGEBOUWEN, GEOFENCES & LIVE HUNTERS
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
    if (typeof window.renderFoxStatusButtons === 'function') {
        window.renderFoxStatusButtons();
    }
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

/* --- LIVE GEBRUIKERS & HUNTERS OP DE KAART (ELKE 10 SEC) --- */
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
    if (typeof window.updateFoxFixedDetailCard === 'function') {
        window.updateFoxFixedDetailCard();
    }
});

setInterval(renderLiveUsersOnMap, 10000);