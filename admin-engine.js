/* ==========================================================================
   4. ADMIN-ENGINE.JS - CENTRALE REKENMOTOR & BEHEER (ALLEEN VOOR ADMIN)
   Inclusief Multi-Admin Master Lock: voorkomt dubbele timers en API-calls
   wanneer meerdere Admins tegelijkertijd ingelogd zijn.
   ========================================================================== */

var rawRdPointsByArea = { "Alpha": [], "Bravo": [], "Delta": [], "Foxtrot": [], "Golf": [], "Hotel": [], "Oscar": [] };

/* --- 0. MULTI-ADMIN LEADER ELECTION (MASTER LOCK) --- */
var adminSessionId = 'admin_' + Math.random().toString(36).substr(2, 9);
var isMasterAdmin = false;
var currentMasterData = null;

function initMasterElection() {
    var lockRef = db.ref('adminMasterLock');

    // Luister wie er op dit moment de Master Admin is
    lockRef.on('value', function(snapshot) {
        currentMasterData = snapshot.val();
        evaluateMasterRole();
    });

    // Controleer elke 12 seconden of wij de Master moeten blijven of worden
    setInterval(evaluateMasterRole, 12000);
}

function evaluateMasterRole() {
    if (!isAdmin) return;
    var now = Date.now();
    var lockRef = db.ref('adminMasterLock');
    var badge = document.getElementById('user-badge');

    // Geen Master aanwezig, wij zijn het al, of de huidige Master is >35 sec offline/inactief
    if (!currentMasterData || currentMasterData.adminId === adminSessionId || (now - (currentMasterData.lastHeartbeat || 0)) > 35000) {
        lockRef.set({
            adminId: adminSessionId,
            lastHeartbeat: now
        });
        // Geef het slot direct vrij zodra dit tabblad wordt gesloten
        lockRef.onDisconnect().remove();
        isMasterAdmin = true;
        if (badge) badge.innerText = "Beheerder (⚡ Master Engine)";
    } else {
        isMasterAdmin = false;
        if (badge) badge.innerText = "Beheerder (👀 Standby Sync)";
    }
}

/* --- 1. WISKUNDE, RICHTINGSVECTOREN & RD-CONVERSIE --- */
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

/* --- 2. CENTRALE BEREKENING & PUBLICATIE NAAR FIREBASE --- */
window.calculateAndPublishMapState = function(forceManual = false) {
    if (!isAdmin) return;
    // Voorkom dat meerdere Admins tegelijkertijd de 30s timer pushen (tenzij handmatig geforceerd na een actie)
    if (!isMasterAdmin && !forceManual) return;

    var now = new Date();
    var currentTotalSeconds = (now.getHours() * 3600) + (now.getMinutes() * 60) + now.getSeconds();
    var computedAreas = {};

    for (var area in rawRdPointsByArea) {
        var points = rawRdPointsByArea[area].slice();
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

        var processedPoints = points.map(function(pt, idx) {
            var isLatest = (idx === points.length - 1);
            var ptMinutes = parseTimeToMinutes(pt.time);
            var diffMinutes = 0;
            if (ptMinutes !== null) {
                var currMin = Math.floor(currentTotalSeconds / 60);
                diffMinutes = currMin - ptMinutes;
            }

            var opacity = 1.0;
            if (diffMinutes > 60) {
                var fade = (diffMinutes - 60) / 180;
                opacity = Math.round(Math.max(0.50, 1.0 - (fade * 0.50)) * 100) / 100;
            }

            return {
                key: pt.key,
                latlng: pt.latlng,
                name: pt.fullName || pt.baseName,
                color: pt.color,
                time: pt.time,
                area: pt.area,
                opacity: opacity,
                extraInfo: (isLatest && speedText) ? speedText : "",
                isLatest: isLatest
            };
        });

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
        var badgeText = isFuture
            ? `🎯 ${area}: 1 m (in toekomst)`
            : `🎯 ${area}: ${currentRadiusMeters >= 1000 ? (currentRadiusMeters / 1000).toFixed(1) + ' km' : currentRadiusMeters + ' m'}`;

        var arrows = [];
        if (bearingDeg !== null && !isFuture) {
            [-60, 60].forEach(function(offsetAngle) {
                var arrowAngle = Math.round((bearingDeg + offsetAngle + 360) % 360);
                var arrowEndCoord = getDestinationLatLng(lastPoint.latlng[0], lastPoint.latlng[1], currentRadiusMeters, arrowAngle);
                arrows.push({
                    angle: arrowAngle,
                    endCoord: arrowEndCoord
                });
            });
        }

        computedAreas[area] = {
            points: processedPoints,
            routeCoords: points.length >= 2 ? points.map(function(p) { return p.latlng; }) : [],
            lineColor: (area === "Oscar") ? "#003399" : (areaColors[area] || "#000000"),
            geofence: {
                center: lastPoint.latlng,
                radiusMeters: currentRadiusMeters,
                color: areaColor,
                badgeText: badgeText,
                arrows: arrows
            }
        };
    }

    db.ref('computedMapState').set({
        updatedAt: Date.now(),
        masterId: adminSessionId,
        areas: computedAreas
    });
};

/* --- 3. ADMIN BEHEERACTIES (RD-PUNTEN, HUISJES & GEBRUIKERS) --- */
window.toggleHouseVisited = function(houseName) {
    if (!isAdmin) return;
    var safeKey = houseName.replace(/[.#$[\]]/g, '_');
    var current = !!houseVisitedStatus[safeKey];
    var updates = {};
    updates[safeKey] = !current;

    db.ref('houseVisited').update(updates).then(function() {
        checkAreaRoundCompletion();
        window.calculateAndPublishMapState(true);
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
                window.calculateAndPublishMapState(true);
            });
        }
    });
}

window.addMarkerByRD = function() {
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
    }).then(function() {
        window.calculateAndPublishMapState(true);
        map.setView(latlng, 14);
    });
};

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
        }).then(function() {
            window.calculateAndPublishMapState(true);
            map.closePopup();
        });
    });
};

window.deleteRdPointPopup = function(key) {
    if (!isAdmin || !key) return;
    if (confirm("Weet je zeker dat je dit RD-punt wilt verwijderen?")) {
        db.ref('rdPoints/' + key).remove().then(function() {
            window.calculateAndPublishMapState(true);
            map.closePopup();
        });
    }
};

window.clearRdPoints = function() {
    if (!isAdmin) return;
    var pinInput = prompt("Voer de admin-pincode in om de RD-lijnen te wissen:", "");
    if (pinInput === "6546") {
        db.ref('rdPoints').remove().then(function() {
            db.ref('computedMapState').remove();
            alert("RD-punten succesvol gewist.");
        });
    } else if (pinInput !== null) { alert("Onjuiste pincode!"); }
};

window.removeInactiveUser = function(userId, userName) {
    if (!isAdmin || !userId) return;
    if (confirm("Wil je inactieve gebruiker '" + userName + "' van de kaart halen?")) {
        db.ref('liveUsers/' + userId).remove().then(function() { map.closePopup(); });
    }
};

/* --- 4. JOTIHUNT API SYNCHRONISATIE (UITSLUITEND DOOR MASTER ADMIN) --- */
async function fetchJotihuntEndpoint(endpoint) {
    var targetUrl = "https://jotihunt.nl/api/2.0/" + endpoint;
    var routes = [
        { url: "https://jotihunt-proxy.joriskleijn2000.workers.dev/?url=" + encodeURIComponent(targetUrl), wrapped: false },
        { url: "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(targetUrl), wrapped: false },
        { url: "https://api.allorigins.win/get?url=" + encodeURIComponent(targetUrl) + "&disableCache=" + Date.now(), wrapped: true }
    ];

    for (var i = 0; i < routes.length; i++) {
        try {
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, 5000);
            var res = await fetch(routes[i].url, { cache: "no-store", signal: controller.signal });
            clearTimeout(timeoutId);
            if (!res.ok) continue;

            var json = await res.json();
            if (routes[i].wrapped) {
                if (!json || !json.contents) continue;
                if (typeof json.contents === 'string' && json.contents.trim().startsWith('<')) continue;
                json = JSON.parse(json.contents);
            }

            if (json && json.data) { return json.data; }
            else if (Array.isArray(json)) { return json; }
            else if (json && typeof json === 'object') { return json; }
        } catch (err) {}
    }
    throw new Error("Geen enkele API-route werkte voor " + endpoint);
}

var isSyncingNow = false;
window.syncJotihuntToFirebase = async function(forceManual = false) {
    if (!isAdmin || isSyncingNow) return;
    // Alleen de Master Admin pollt automatisch de Jotihunt API (tenzij op '🔔 Laatste' is geklikt)
    if (!isMasterAdmin && !forceManual) return;

    isSyncingNow = true;
    var updatePayload = { lastSync: Date.now() };
    var anySuccess = false;

    try {
        var areasData = await fetchJotihuntEndpoint("areas");
        if (Array.isArray(areasData) && areasData.length > 0) {
            updatePayload.areas = areasData;
            anySuccess = true;
        }
    } catch (areaErr) {}

    await new Promise(function(r) { setTimeout(r, 1000); });

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
};

window.fetchLatestArticleManual = function() {
    window.syncJotihuntToFirebase(true).then(function() {
        var art = document.getElementById('notification-text').innerText;
        if (art) document.getElementById('notification-banner').style.display = 'flex';
    });
};

/* --- 5. INITIALISATIE VAN DE ADMIN ENGINE --- */
window.initAdminEngine = function() {
    // 1. Start Master-Admin verkiezing
    initMasterElection();

    // 2. Stel Proj4js RD-projectie in
    proj4.defs("EPSG:28992", "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.387638888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.524,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs");
    proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

    // 3. Activeer Leaflet Tekentools
    var drawControl = new L.Control.Draw({
        edit: { featureGroup: drawnItems, remove: true },
        draw: {
            polygon: false, rectangle: false, circle: false, circlemarker: false, marker: true,
            polyline: { shapeOptions: { color: '#000000', weight: 4, className: 'route-line' } }
        }
    });
    map.addControl(drawControl);

    // 4. Herteken de clubgebouwen zodat de Admin-knoppen ('Markeer als bezocht') verschijnen
    renderFixedHouses();

    // 5. Luister naar ruwe RD-punten en herbereken wanneer wij de Master zijn
    db.ref('rdPoints').on('value', function(snapshot) {
        for (var a in rawRdPointsByArea) rawRdPointsByArea[a] = [];
        var data = snapshot.val();
        if (data) {
            Object.keys(data).forEach(function(key) {
                var p = data[key];
                if (p && p.latlng && Array.isArray(p.latlng) && p.latlng.length === 2) {
                    if (p.area && rawRdPointsByArea[p.area]) {
                        rawRdPointsByArea[p.area].push({
                            key: key, latlng: p.latlng, time: p.time || "12:00",
                            baseName: p.baseName || "Punt", fullName: p.fullName || p.baseName,
                            area: p.area, color: p.color || areaColors[p.area] || "#000000",
                            createdTimestamp: p.createdTimestamp || p.createdAt || Date.now()
                        });
                    }
                }
            });
        }
        window.calculateAndPublishMapState(false);
    });

    // 6. Start de 30-seconden Admin-rekenklok (wordt alleen uitgevoerd door de actieve Master Admin)
    setInterval(function() {
        window.calculateAndPublishMapState(false);
    }, 30000);

    // 7. Start de Jotihunt API-synchronisatie (elke 45 seconden door de Master Admin)
    setTimeout(function() {
        window.syncJotihuntToFirebase(false);
    }, 1500);
    setInterval(function() {
        window.syncJotihuntToFirebase(false);
    }, 45000);
};