/* ==========================================================================
   4. ADMIN-ENGINE.JS - CENTRALE REKENMOTOR & BEHEER (ALLEEN VOOR ADMIN)
   Inclusief:
   - Multi-Admin Master Lock
   - RD (met/zonder komma), GPS & Adres-Geocoding (PDOK / OSM)
   - Gekleurde Dropdown (Hint / Hunt / Anders) waarbij 'Anders' geen gebied/tijd heeft
   - Slimme Loopsnelheid: Hunt-punten (laatste 2 tellen voor 50%), fallback naar Hint,
     standaard 6.5 km/u, en filter voor >X min op Status Rood (aan/uit te zetten met schuifje).
   ========================================================================== */

var rawRdPointsByArea = { "Alpha": [], "Bravo": [], "Delta": [], "Foxtrot": [], "Golf": [], "Hotel": [], "Oscar": [] };
var rawOtherPoints = []; // Voor punten met type "Anders" (zonder deelgebied en tijdstip)
var currentEditingRdKey = null;

/* Instellingen voor snelheidsberekening & rode status (gesynchroniseerd met Firebase) */
var speedSettings = {
    ignoreRedStatus: true,
    redThresholdMinutes: 10,
    defaultSpeedKmh: 6.5
};

/* Geschiedenis van rode status per deelgebied om >X min rood te detecteren */
var areaRedHistory = {};

/* --- 0. MULTI-ADMIN LEADER ELECTION (MASTER LOCK) --- */
var adminSessionId = 'admin_' + Math.random().toString(36).substr(2, 9);
var isMasterAdmin = false;
var currentMasterData = null;

function initMasterElection() {
    var lockRef = db.ref('adminMasterLock');

    lockRef.on('value', function(snapshot) {
        currentMasterData = snapshot.val();
        evaluateMasterRole();
    });

    setInterval(evaluateMasterRole, 12000);
}

function evaluateMasterRole() {
    if (!isAdmin) return;
    var now = Date.now();
    var lockRef = db.ref('adminMasterLock');
    var badge = document.getElementById('user-badge');

    if (!currentMasterData || currentMasterData.adminId === adminSessionId || (now - (currentMasterData.lastHeartbeat || 0)) > 35000) {
        lockRef.set({
            adminId: adminSessionId,
            lastHeartbeat: now
        });
        lockRef.onDisconnect().remove();
        isMasterAdmin = true;
        if (badge) badge.innerText = "Beheerder (⚡ Master Engine)";
    } else {
        isMasterAdmin = false;
        if (badge) badge.innerText = "Beheerder (👀 Standby Sync)";
    }
}

/* --- 1. WISKUNDE, RICHTINGSVECTOREN, RD-CONVERSIE & GEOCODING --- */
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

function parseTargetArea(input) {
    if (!input) return "";
    var cleanInput = input.trim().toLowerCase();
    return targetAreas.find(function(area) {
        return area.toLowerCase() === cleanInput;
    }) || "";
}

/* Ondersteunt RD met of zonder komma (1645, 4312 of 1645 4312) én GPS-coördinaten (51.9851, 5.8987) */
function parseCoordInput(coordInput) {
    if (!coordInput) return null;
    var clean = coordInput.trim();

    if (!/^[\d\s.,;-]+$/.test(clean)) {
        return null;
    }

    var parts = clean.split(/[\s,;]+/).filter(Boolean);
    if (parts.length !== 2) return null;

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

/* Zet RD, GPS óf een gekopieerd adres (bijv. "Ernest Hemingwaystraat 73, 6836 TK Arnhem") om naar [lat, lng] */
async function resolveLocationInput(rawInput) {
    if (!rawInput || !rawInput.trim()) return null;

    var directCoords = parseCoordInput(rawInput);
    if (directCoords) return directCoords;

    var query = rawInput.trim();
    try {
        var pdokUrl = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=" + encodeURIComponent(query) + "&rows=1";
        var res = await fetch(pdokUrl);
        if (res.ok) {
            var data = await res.json();
            if (data && data.response && data.response.docs && data.response.docs.length > 0) {
                var centroide = data.response.docs[0].centroide_ll;
                if (centroide) {
                    var match = centroide.match(/POINT\(([\d.-]+)\s+([\d.-]+)\)/);
                    if (match) {
                        var lng = parseFloat(match[1]);
                        var lat = parseFloat(match[2]);
                        if (!isNaN(lat) && !isNaN(lng)) return [lat, lng];
                    }
                }
            }
        }
    } catch (e) {
        console.warn("PDOK adres-lookup mislukt, probeer fallback...", e);
    }

    try {
        var nomUrl = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl&q=" + encodeURIComponent(query);
        var nomRes = await fetch(nomUrl);
        if (nomRes.ok) {
            var nomData = await nomRes.json();
            if (Array.isArray(nomData) && nomData.length > 0) {
                var lat2 = parseFloat(nomData[0].lat);
                var lng2 = parseFloat(nomData[0].lon);
                if (!isNaN(lat2) && !isNaN(lng2)) return [lat2, lng2];
            }
        }
    } catch (e2) {
        console.warn("Nominatim adres-lookup mislukt:", e2);
    }

    return null;
}

function toLocalIsoString(dateObj) {
    var d = dateObj || new Date();
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function getPointTimestampMs(pt) {
    if (pt.pointTimestamp && !isNaN(pt.pointTimestamp)) {
        return Number(pt.pointTimestamp);
    }
    if (pt.datetimeIso) {
        var parsed = new Date(pt.datetimeIso).getTime();
        if (!isNaN(parsed)) return parsed;
    }
    if (pt.time && pt.time.includes(':')) {
        var baseDate = pt.createdTimestamp ? new Date(pt.createdTimestamp) : new Date();
        var parts = pt.time.split(':');
        baseDate.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
        return baseDate.getTime();
    }
    return pt.createdTimestamp || Date.now();
}

/* --- 2. RODE STATUS TRACKING & SLIMME SNELHEIDSBEREKENING --- */
function updateRedStatusTracking(areasArray) {
    if (!Array.isArray(areasArray)) return;
    var now = Date.now();
    var changed = false;

    targetAreas.forEach(function(areaName) {
        var areaObj = areasArray.find(function(a) {
            return (a.name || a.title || '').toLowerCase().includes(areaName.toLowerCase());
        });
        if (!areaObj) return;

        var raw = areaObj.status || areaObj.state || areaObj.status_text || areaObj.status_id || '';
        var cat = getNormalizedStatusCategory(raw);

        if (!areaRedHistory[areaName]) {
            areaRedHistory[areaName] = { isRed: false, redStartMs: null, periods: [] };
        }
        var hist = areaRedHistory[areaName];

        if (cat.key === 'rood') {
            if (!hist.isRed) {
                hist.isRed = true;
                hist.redStartMs = now;
                changed = true;
            }
        } else {
            if (hist.isRed) {
                var startMs = hist.redStartMs || now;
                if (!hist.periods) hist.periods = [];
                hist.periods.push({ startMs: startMs, endMs: now });
                // Bewaar laatste 30 rode periodes per deelgebied
                if (hist.periods.length > 30) hist.periods.shift();
                hist.isRed = false;
                hist.redStartMs = null;
                changed = true;
            }
        }
    });

    if (changed && isMasterAdmin) {
        db.ref('areaRedHistory').set(areaRedHistory);
    }
}

/* Controleert of er tussen t1Ms en t2Ms een status 'rood' is geweest van langer dan X minuten */
function hadLongRedBetween(areaName, t1Ms, t2Ms, pointB) {
    if (!speedSettings.ignoreRedStatus) return false;
    var thresholdMs = (Number(speedSettings.redThresholdMinutes) || 10) * 60 * 1000;

    // 1. Check of op het punt zelf al was vastgelegd dat hij na >X min rood kwam
    if (pointB && pointB.redDurationBeforeMs && pointB.redDurationBeforeMs >= thresholdMs) {
        return true;
    }

    // 2. Check de opgeslagen rode periodes van dit deelgebied
    var hist = areaRedHistory[areaName];
    if (!hist) return false;

    var periods = (hist.periods || []).slice();
    if (hist.isRed && hist.redStartMs) {
        periods.push({ startMs: hist.redStartMs, endMs: Date.now() });
    }

    for (var i = 0; i < periods.length; i++) {
        var p = periods[i];
        var duration = p.endMs - p.startMs;
        // Als de rode periode langer duurde dan X min én plaatsvond tussen punt A en punt B
        if (duration >= thresholdMs && p.endMs > t1Ms && p.startMs <= t2Ms) {
            return true;
        }
    }
    return false;
}

/* Berekent de geldige snelheidssegmenten uit een lijst van punten */
function getValidSpeedSegments(pts, areaName) {
    var segments = [];
    for (var i = 0; i < pts.length - 1; i++) {
        var pA = pts[i];
        var pB = pts[i + 1];
        var t1 = getPointTimestampMs(pA);
        var t2 = getPointTimestampMs(pB);

        if (t2 <= t1) continue;

        // Negeer dit segment als het deelgebied tussendoor >X min op rood heeft gestaan (auto-vervoer)
        if (hadLongRedBetween(areaName, t1, t2, pB)) {
            continue;
        }

        var distKm = getDistanceKm(pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1]);
        var hours = (t2 - t1) / 3600000;
        if (hours > 0) {
            var kmh = distKm / hours;
            segments.push(kmh);
        }
    }
    return segments;
}

/* Berekent het gewogen gemiddelde waarbij het laatste segment altijd voor 50% meetelt */
function computeWeightedSpeedFromSegments(segments) {
    if (!segments || segments.length === 0) return null;
    if (segments.length === 1) {
        return segments[0];
    }
    var lastSegSpeed = segments[segments.length - 1];
    var prevSegments = segments.slice(0, segments.length - 1);
    var sumPrev = prevSegments.reduce(function(acc, val) { return acc + val; }, 0);
    var avgPrev = sumPrev / prevSegments.length;

    // Laatste 2 punten (laatste segment) tellen voor 50% mee, eerdere segmenten samen voor 50%
    return (0.50 * lastSegSpeed) + (0.50 * avgPrev);
}

/* Hoofdfunctie voor loopsnelheid van een deelgebied */
function calculateAreaWalkingSpeed(areaPoints, areaName) {
    var defaultKmh = Number(speedSettings.defaultSpeedKmh) || 6.5;

    // Stap 1: Filter alleen de 'Hunt' punten
    var huntPoints = areaPoints.filter(function(p) {
        return (p.pointType || p.baseName) === "Hunt";
    });

    var huntSegments = getValidSpeedSegments(huntPoints, areaName);
    if (huntSegments.length > 0) {
        var rawHuntSpeed = computeWeightedSpeedFromSegments(huntSegments);
        var clampedHunt = Math.min(12.0, Math.max(0.5, rawHuntSpeed));
        var displayHunt = Math.round(rawHuntSpeed * 10) / 10;
        return {
            speedKmh: clampedHunt,
            speedText: `~${displayHunt} km/u (Hunt)`
        };
    }

    // Stap 2: Fallback naar 'Hunt' + 'Hint' punten als er geen/onvoldoende geldige Hunt-segmenten zijn
    var huntAndHintPoints = areaPoints.filter(function(p) {
        var t = p.pointType || p.baseName || "Hint";
        return t === "Hunt" || t === "Hint";
    });

    var combinedSegments = getValidSpeedSegments(huntAndHintPoints, areaName);
    if (combinedSegments.length > 0) {
        var rawCombinedSpeed = computeWeightedSpeedFromSegments(combinedSegments);
        var clampedCombined = Math.min(12.0, Math.max(0.5, rawCombinedSpeed));
        var displayCombined = Math.round(rawCombinedSpeed * 10) / 10;
        return {
            speedKmh: clampedCombined,
            speedText: `~${displayCombined} km/u (incl. Hint)`
        };
    }

    // Stap 3: Echt helemaal geen bruikbare Hunt of Hint segmenten -> Standaard 6,5 km/u
    return {
        speedKmh: defaultKmh,
        speedText: `~${defaultKmh} km/u (Standaard)`
    };
}

/* --- 3. CENTRALE BEREKENING & PUBLICATIE NAAR FIREBASE --- */
window.calculateAndPublishMapState = function(forceManual = false) {
    if (!isAdmin) return;
    if (!isMasterAdmin && !forceManual) return;

    var nowMs = Date.now();
    var computedAreas = {};

    for (var area in rawRdPointsByArea) {
        var points = rawRdPointsByArea[area].slice();
        if (points.length === 0) continue;

        points.sort(function(a, b) {
            return getPointTimestampMs(a) - getPointTimestampMs(b);
        });
        var lastPoint = points[points.length - 1];

        // Bereken de loopsnelheid volgens de nieuwe Hunt/Hint/Rood-regels
        var speedResult = calculateAreaWalkingSpeed(points, area);
        var calculatedSpeedKmh = speedResult.speedKmh;
        var speedText = speedResult.speedText;

        var bearingDeg = null;
        if (points.length >= 2) {
            var sumSin = 0, sumCos = 0, totalWeight = 0;
            var pA = points[points.length - 2];
            var pB = points[points.length - 1];
            var b1 = getBearing(pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1]) * Math.PI / 180;
            sumSin += 0.40 * Math.sin(b1); sumCos += 0.40 * Math.cos(b1); totalWeight += 0.40;

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
            var ptMs = getPointTimestampMs(pt);
            var diffMinutes = Math.floor((nowMs - ptMs) / 60000);

            var opacity = 1.0;
            if (diffMinutes > 60) {
                var fade = (diffMinutes - 60) / 180;
                opacity = Math.round(Math.max(0.50, 1.0 - (fade * 0.50)) * 100) / 100;
            }

            return {
                key: pt.key,
                latlng: pt.latlng,
                name: pt.fullName || pt.baseName,
                pointType: pt.pointType || pt.baseName || "Hint",
                color: pt.color,
                time: pt.time,
                datetimeIso: pt.datetimeIso || null,
                pointTimestamp: ptMs,
                area: pt.area,
                opacity: opacity,
                extraInfo: isLatest ? speedText : "",
                isLatest: isLatest
            };
        });

        var lastPtMs = getPointTimestampMs(lastPoint);
        var isFuture = (lastPtMs > nowMs);
        var secondsPassed = isFuture ? 0 : Math.floor((nowMs - lastPtMs) / 1000);

        var currentRadiusMeters = 1;
        if (!isFuture) {
            var effectiveSpeedKmh = calculatedSpeedKmh !== null ? calculatedSpeedKmh : 6.5;
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

    // Verwerk losse 'Anders'-punten (zonder deelgebied en zonder tijdstip)
    var processedOtherPoints = rawOtherPoints.map(function(pt) {
        return {
            key: pt.key,
            latlng: pt.latlng,
            name: pt.fullName || pt.baseName || "Anders",
            pointType: "Anders",
            color: pt.color || "#34495e",
            time: "",
            area: "",
            opacity: 1.0,
            extraInfo: "",
            isLatest: false
        };
    });

    db.ref('computedMapState').set({
        updatedAt: Date.now(),
        masterId: adminSessionId,
        areas: computedAreas,
        otherPoints: processedOtherPoints
    });
};

/* --- 4. RD-PUNT MODAL & SNELHEIDS-INSTELLINGEN (X WAARDE & RODE STAAT SCHUIFJE) --- */
function injectRdModalUI() {
    if (document.getElementById('rd-modal-overlay')) return;

    var style = document.createElement('style');
    style.innerHTML = `
        #rd-modal-overlay {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(26, 37, 47, 0.85); backdrop-filter: blur(3px);
            z-index: 3000; justify-content: center; align-items: center; padding: 10px;
        }
        #rd-modal-box {
            background: #2c3e50; color: #ecf0f1; width: 100%; max-width: 390px;
            max-height: 92vh; overflow-y: auto;
            border-radius: 8px; padding: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            border: 1px solid #4a6278; display: flex; flex-direction: column; gap: 11px;
            font-size: 0.85rem;
        }
        #rd-modal-box h3 {
            margin: 0 0 2px 0; font-size: 1.05rem; color: #ffffff;
            border-bottom: 1px solid #4a6278; padding-bottom: 6px;
        }
        .rd-field-group { display: flex; flex-direction: column; gap: 4px; }
        .rd-field-group label { font-weight: 600; font-size: 0.78rem; color: #bdc3c7; }
        .rd-input, .rd-select {
            width: 100%; padding: 8px 10px; border-radius: 5px;
            border: 1px solid #4a6278; background: #34495e; color: #ecf0f1;
            font-size: 0.88rem; outline: none; font-weight: 600;
        }
        .rd-input:focus, .rd-select:focus { border-color: #3498db; }
        /* Specifieke dropdown-kleuren voor alleen dit menu */
        #rd-type-select.type-hunt { background-color: #2ecc71 !important; color: #ffffff !important; border-color: #27ae60 !important; }
        #rd-type-select.type-hint { background-color: #5dade2 !important; color: #ffffff !important; border-color: #3498db !important; }
        #rd-type-select.type-anders { background-color: #34495e !important; color: #ecf0f1 !important; border-color: #4a6278 !important; }
        #rd-type-select option[value="Hunt"] { background-color: #2ecc71; color: #ffffff; font-weight: bold; }
        #rd-type-select option[value="Hint"] { background-color: #5dade2; color: #ffffff; font-weight: bold; }
        #rd-type-select option[value="Anders"] { background-color: #34495e; color: #ecf0f1; font-weight: bold; }
        #rd-modal-hint-note { font-size: 0.73rem; color: #85c1e9; display: none; }
        #rd-modal-anders-note { font-size: 0.73rem; color: #f39c12; display: none; }
        #rd-modal-error {
            display: none; background: rgba(231, 76, 60, 0.2); border: 1px solid #e74c3c;
            color: #ff7675; padding: 6px 8px; border-radius: 4px; font-size: 0.78rem; font-weight: 600;
        }
        /* Snelheids-instellingen sectie met schuifje (toggle switch) en X-waarde */
        .rd-settings-box {
            background: rgba(26, 37, 47, 0.55); border: 1px solid #4a6278;
            border-radius: 6px; padding: 10px; margin-top: 2px;
            display: flex; flex-direction: column; gap: 8px;
        }
        .rd-settings-title { font-weight: bold; font-size: 0.78rem; color: #f1c40f; }
        .rd-toggle-row {
            display: flex; justify-content: space-between; align-items: center; gap: 10px;
        }
        .rd-toggle-label { font-size: 0.76rem; color: #ecf0f1; line-height: 1.25; }
        /* Toggle Switch CSS */
        .rd-switch { position: relative; display: inline-block; width: 42px; height: 22px; flex-shrink: 0; }
        .rd-switch input { opacity: 0; width: 0; height: 0; }
        .rd-slider {
            position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
            background-color: #7f8c8d; transition: .25s; border-radius: 22px;
        }
        .rd-slider:before {
            position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px;
            background-color: white; transition: .25s; border-radius: 50%;
        }
        .rd-switch input:checked + .rd-slider { background-color: #2ecc71; }
        .rd-switch input:checked + .rd-slider:before { transform: translateX(20px); }
        .rd-x-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .rd-x-input {
            width: 70px; padding: 5px 8px; border-radius: 4px; border: 1px solid #4a6278;
            background: #34495e; color: #ffffff; font-weight: bold; text-align: center;
        }
        .rd-modal-actions { display: flex; gap: 8px; margin-top: 4px; }
        .rd-btn {
            flex: 1; padding: 9px; border: none; border-radius: 5px;
            font-weight: bold; font-size: 0.85rem; cursor: pointer; color: white;
        }
        .rd-btn-save { background: #27ae60; }
        .rd-btn-save:disabled { background: #7f8c8d; cursor: wait; }
        .rd-btn-cancel { background: #7f8c8d; }
    `;
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.id = 'rd-modal-overlay';
    overlay.innerHTML = `
        <div id="rd-modal-box">
            <h3 id="rd-modal-title">📍 RD-Punt Toevoegen</h3>

            <div class="rd-field-group">
                <label for="rd-type-select">Type punt (Naam):</label>
                <select id="rd-type-select" class="rd-select type-hint">
                    <option value="Hint">Hint</option>
                    <option value="Hunt">Hunt</option>
                    <option value="Anders">Anders</option>
                </select>
                <span id="rd-modal-anders-note">ℹ️ Bij 'Anders' wordt geen deelgebied en geen tijdstip opgeslagen.</span>
            </div>

            <div class="rd-field-group">
                <label for="rd-loc-input">Locatie (RD met/zonder komma, GPS of Adres):</label>
                <input type="text" id="rd-loc-input" class="rd-input" placeholder="Bijv: 1645 4312 of Ernest Hemingwaystraat 73, Arnhem">
            </div>

            <div class="rd-field-group" id="rd-area-group">
                <label for="rd-area-select">Deelgebied:</label>
                <select id="rd-area-select" class="rd-select">
                    <option value="">-- Kies deelgebied --</option>
                    <option value="Alpha">Alpha</option>
                    <option value="Bravo">Bravo</option>
                    <option value="Delta">Delta</option>
                    <option value="Foxtrot">Foxtrot</option>
                    <option value="Golf">Golf</option>
                    <option value="Hotel">Hotel</option>
                    <option value="Oscar">Oscar</option>
                </select>
            </div>

            <div class="rd-field-group" id="rd-datetime-group">
                <label for="rd-datetime-input">Datum & Tijdstip:</label>
                <input type="datetime-local" id="rd-datetime-input" class="rd-input" required>
                <span id="rd-modal-hint-note">ℹ️ Voor een 'Hint' zijn alleen hele uren (:00) toegestaan.</span>
            </div>

            <!-- Menu voor waarde X en schuifje voor rode status bij snelheidsberekening -->
            <div class="rd-settings-box">
                <div class="rd-settings-title">⚙️ Loopsnelheid & Rode Status Filter</div>
                <div class="rd-toggle-row">
                    <span class="rd-toggle-label">Negeer Hunt-punt na rode status (&gt; X min) voor snelheid:</span>
                    <label class="rd-switch">
                        <input type="checkbox" id="rd-red-toggle" checked>
                        <span class="rd-slider"></span>
                    </label>
                </div>
                <div class="rd-x-row" id="rd-x-Wrapper">
                    <span class="rd-toggle-label">Waarde voor <b>X</b> (minuten op rood):</span>
                    <input type="number" id="rd-x-minutes" class="rd-x-input" min="1" max="180" value="10">
                </div>
            </div>

            <div id="rd-modal-error"></div>

            <div class="rd-modal-actions">
                <button type="button" class="rd-btn rd-btn-cancel" id="rd-btn-cancel">Annuleren</button>
                <button type="button" class="rd-btn rd-btn-save" id="rd-btn-save">Opslaan</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    var typeSelect = document.getElementById('rd-type-select');
    var areaGroup = document.getElementById('rd-area-group');
    var areaSelect = document.getElementById('rd-area-select');
    var dtGroup = document.getElementById('rd-datetime-group');
    var dtInput = document.getElementById('rd-datetime-input');
    var hintNote = document.getElementById('rd-modal-hint-note');
    var andersNote = document.getElementById('rd-modal-anders-note');
    var redToggle = document.getElementById('rd-red-toggle');
    var xMinutesInput = document.getElementById('rd-x-minutes');

    function updateTypeDropdownStyle() {
        var val = typeSelect.value;
        typeSelect.className = 'rd-select ' + (val === 'Hunt' ? 'type-hunt' : (val === 'Hint' ? 'type-hint' : 'type-anders'));

        if (val === 'Anders') {
            // Bij 'Anders' kan en hoeft er GEEN deelgebied en GEEN tijdstip ingevoerd te worden
            areaGroup.style.display = 'none';
            areaSelect.value = '';
            areaSelect.disabled = true;

            dtGroup.style.display = 'none';
            dtInput.value = '';
            dtInput.disabled = true;

            hintNote.style.display = 'none';
            andersNote.style.display = 'block';
        } else {
            areaGroup.style.display = 'flex';
            areaSelect.disabled = false;

            dtGroup.style.display = 'flex';
            dtInput.disabled = false;
            andersNote.style.display = 'none';

            // Zorg dat er altijd direct de huidige datum en tijd staan als het veld leeg was
            if (!dtInput.value) {
                var now = new Date();
                if (val === 'Hint') {
                    now.setMinutes(0, 0, 0);
                }
                dtInput.value = toLocalIsoString(now);
            }

            if (val === 'Hint') {
                hintNote.style.display = 'block';
                if (dtInput.value && dtInput.value.includes('T')) {
                    var parts = dtInput.value.split(':');
                    if (parts.length >= 2 && parts[1] !== '00') {
                        dtInput.value = parts[0] + ':00';
                    }
                }
            } else {
                hintNote.style.display = 'none';
            }
        }
    }

    typeSelect.addEventListener('change', updateTypeDropdownStyle);

    dtInput.addEventListener('change', function() {
        if (typeSelect.value === 'Hint' && dtInput.value && dtInput.value.includes(':')) {
            var parts = dtInput.value.split(':');
            if (parts[1] !== '00') {
                dtInput.value = parts[0] + ':00';
            }
        }
    });

    // Sla wijzigingen aan het schuifje of waarde X direct op naar Firebase en herbereken de snelheid
    function syncSpeedSettingsFromUI() {
        var newIgnore = !!redToggle.checked;
        var newX = Math.max(1, parseInt(xMinutesInput.value, 10) || 10);
        speedSettings.ignoreRedStatus = newIgnore;
        speedSettings.redThresholdMinutes = newX;

        db.ref('adminSettings').update({
            ignoreRedStatus: newIgnore,
            redThresholdMinutes: newX
        }).then(function() {
            window.calculateAndPublishMapState(true);
        });
    }

    redToggle.addEventListener('change', syncSpeedSettingsFromUI);
    xMinutesInput.addEventListener('change', syncSpeedSettingsFromUI);

    document.getElementById('rd-btn-cancel').addEventListener('click', closeRdModal);
    document.getElementById('rd-btn-save').addEventListener('click', saveRdModalData);
}

function openRdModal(mode, existingKey, existingData) {
    injectRdModalUI();
    currentEditingRdKey = (mode === 'edit') ? existingKey : null;

    var titleEl = document.getElementById('rd-modal-title');
    var typeSelect = document.getElementById('rd-type-select');
    var locInput = document.getElementById('rd-loc-input');
    var areaSelect = document.getElementById('rd-area-select');
    var dtInput = document.getElementById('rd-datetime-input');
    var redToggle = document.getElementById('rd-red-toggle');
    var xMinutesInput = document.getElementById('rd-x-minutes');
    var errBox = document.getElementById('rd-modal-error');
    errBox.style.display = 'none';

    // Zet schuifje en waarde X op de actuele Firebase-instelling
    redToggle.checked = !!speedSettings.ignoreRedStatus;
    xMinutesInput.value = Number(speedSettings.redThresholdMinutes) || 10;

    if (mode === 'edit' && existingData) {
        titleEl.innerText = "✏️ RD-Punt Bewerken";
        var allowedTypes = ["Hint", "Hunt", "Anders"];
        var currentType = existingData.pointType || existingData.baseName || "Hint";
        typeSelect.value = allowedTypes.includes(currentType) ? currentType : "Anders";

        if (existingData.rawLocationInput) {
            locInput.value = existingData.rawLocationInput;
        } else if (existingData.latlng) {
            locInput.value = `${existingData.latlng[0].toFixed(5)}, ${existingData.latlng[1].toFixed(5)}`;
        } else {
            locInput.value = "";
        }

        if (typeSelect.value === "Anders") {
            areaSelect.value = "";
            dtInput.value = "";
        } else {
            areaSelect.value = existingData.area || "";
            if (existingData.datetimeIso) {
                dtInput.value = existingData.datetimeIso;
            } else {
                var fallbackDate = existingData.pointTimestamp ? new Date(existingData.pointTimestamp) : new Date(existingData.createdTimestamp || Date.now());
                if (existingData.time && existingData.time.includes(':')) {
                    var tParts = existingData.time.split(':');
                    fallbackDate.setHours(parseInt(tParts[0], 10) || 0, parseInt(tParts[1], 10) || 0, 0, 0);
                }
                dtInput.value = toLocalIsoString(fallbackDate);
            }
        }
    } else {
        titleEl.innerText = "📍 Nieuw RD-Punt Toevoegen";
        // Standaard openen met huidige datum & tijd direct ingevuld!
        // We zetten hem standaard op 'Hunt' zodat de exacte huidige minuut direct zichtbaar is (bij wissel naar 'Hint' rondt hij af op :00)
        typeSelect.value = "Hunt";
        locInput.value = "";
        areaSelect.value = "";

        var now = new Date();
        dtInput.value = toLocalIsoString(now);
    }

    typeSelect.dispatchEvent(new Event('change'));
    document.getElementById('rd-modal-overlay').style.display = 'flex';
    locInput.focus();
}

function closeRdModal() {
    var overlay = document.getElementById('rd-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    currentEditingRdKey = null;
}

async function saveRdModalData() {
    if (!isAdmin) return;

    var typeSelect = document.getElementById('rd-type-select');
    var locInput = document.getElementById('rd-loc-input');
    var areaSelect = document.getElementById('rd-area-select');
    var dtInput = document.getElementById('rd-datetime-input');
    var errBox = document.getElementById('rd-modal-error');
    var saveBtn = document.getElementById('rd-btn-save');

    errBox.style.display = 'none';

    var chosenType = typeSelect.value; // "Hint", "Hunt" of "Anders"
    var rawLoc = locInput.value.trim();

    if (!rawLoc) {
        errBox.innerText = "Voer een RD-coördinaat, GPS-coördinaat of adres in.";
        errBox.style.display = 'block';
        return;
    }

    var chosenArea = "";
    var timeFormatted = "";
    var dtVal = null;
    var pointTimestampMs = null;

    // Alleen voor 'Hint' en 'Hunt' zijn Deelgebied en Datum/Tijd van toepassing
    if (chosenType !== "Anders") {
        chosenArea = parseTargetArea(areaSelect.value);
        if (!chosenArea) {
            errBox.innerText = "Kies een deelgebied voor dit " + chosenType + "-punt.";
            errBox.style.display = 'block';
            return;
        }

        dtVal = dtInput.value;
        if (!dtVal || !dtVal.includes('T')) {
            errBox.innerText = "Kies een geldige datum en tijd via de datum/tijd-picker.";
            errBox.style.display = 'block';
            return;
        }

        var dateObj = new Date(dtVal);
        if (isNaN(dateObj.getTime())) {
            errBox.innerText = "Ongeldige datum of tijd gekozen.";
            errBox.style.display = 'block';
            return;
        }

        if (chosenType === "Hint" && dateObj.getMinutes() !== 0) {
            errBox.innerText = "Voor een 'Hint' moeten altijd hele uren (bijv. 14:00) worden ingevoerd!";
            errBox.style.display = 'block';
            return;
        }

        var hh = String(dateObj.getHours()).padStart(2, '0');
        var mm = String(dateObj.getMinutes()).padStart(2, '0');
        timeFormatted = `${hh}:${mm}`;
        pointTimestampMs = dateObj.getTime();
    }

    saveBtn.disabled = true;
    saveBtn.innerText = "Zoeken...";

    var latlng = await resolveLocationInput(rawLoc);

    saveBtn.disabled = false;
    saveBtn.innerText = "Opslaan";

    if (!latlng) {
        errBox.innerText = "Locatie niet gevonden. Controleer het RD-punt, de coördinaten of het adres.";
        errBox.style.display = 'block';
        return;
    }

    var markerColor = "#34495e";
    var areaSuffix = "";
    if (chosenType !== "Anders" && chosenArea && areaColors[chosenArea]) {
        markerColor = areaColors[chosenArea];
        areaSuffix = " [" + chosenArea + "]";
    }

    // Check of het deelgebied vlak voor dit punt op rood stond (zodat het punt dit zelf ook onthoudt in Firebase)
    var redDurationBeforeMs = 0;
    if (chosenArea && areaRedHistory[chosenArea]) {
        var hist = areaRedHistory[chosenArea];
        if (hist.isRed && hist.redStartMs) {
            redDurationBeforeMs = Math.max(0, (pointTimestampMs || Date.now()) - hist.redStartMs);
        } else if (hist.periods && hist.periods.length > 0) {
            var lastPeriod = hist.periods[hist.periods.length - 1];
            // Als dit het eerste punt is na de laatst geregistreerde rode periode
            var existingPts = rawRdPointsByArea[chosenArea] || [];
            var lastKnownPtMs = existingPts.length > 0 ? getPointTimestampMs(existingPts[existingPts.length - 1]) : 0;
            if (lastPeriod.endMs > lastKnownPtMs && (pointTimestampMs || Date.now()) >= lastPeriod.startMs) {
                redDurationBeforeMs = Math.max(0, lastPeriod.endMs - lastPeriod.startMs);
            }
        }
    }

    var payload = {
        latlng: latlng,
        rawLocationInput: rawLoc,
        pointType: chosenType,
        baseName: chosenType,
        fullName: chosenType + areaSuffix,
        area: chosenType === "Anders" ? "" : chosenArea,
        color: markerColor,
        time: chosenType === "Anders" ? "" : timeFormatted,
        datetimeIso: chosenType === "Anders" ? null : dtVal,
        pointTimestamp: chosenType === "Anders" ? null : pointTimestampMs,
        redDurationBeforeMs: redDurationBeforeMs
    };

    if (currentEditingRdKey) {
        payload.updatedAt = Date.now();
        db.ref('rdPoints/' + currentEditingRdKey).update(payload).then(function() {
            closeRdModal();
            window.calculateAndPublishMapState(true);
            map.closePopup();
        });
    } else {
        payload.createdAt = Date.now();
        payload.createdTimestamp = Date.now();
        db.ref('rdPoints').push(payload).then(function() {
            closeRdModal();
            window.calculateAndPublishMapState(true);
            map.setView(latlng, 14);
        });
    }
}

/* --- 5. ADMIN BEHEERACTIES (RD-PUNTEN, HUISJES & GEBRUIKERS) --- */
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
    openRdModal('add', null, null);
};

window.editRdPointPopup = function(key) {
    if (!isAdmin || !key) return;
    db.ref('rdPoints/' + key).once('value', function(snapshot) {
        var p = snapshot.val();
        if (!p) return;
        openRdModal('edit', key, p);
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

/* --- 6. JOTIHUNT API SYNCHRONISATIE (UITSLUITEND DOOR MASTER ADMIN) --- */
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
    if (!isMasterAdmin && !forceManual) return;

    isSyncingNow = true;
    var updatePayload = { lastSync: Date.now() };
    var anySuccess = false;

    try {
        var areasData = await fetchJotihuntEndpoint("areas");
        if (Array.isArray(areasData) && areasData.length > 0) {
            updatePayload.areas = areasData;
            updateRedStatusTracking(areasData);
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

/* --- 7. INITIALISATIE VAN DE ADMIN ENGINE --- */
window.initAdminEngine = function() {
    initMasterElection();

    proj4.defs("EPSG:28992", "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.387638888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.524,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs");
    proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

    injectRdModalUI();

    var drawControl = new L.Control.Draw({
        edit: { featureGroup: drawnItems, remove: true },
        draw: {
            polygon: false, rectangle: false, circle: false, circlemarker: false, marker: true,
            polyline: { shapeOptions: { color: '#000000', weight: 4, className: 'route-line' } }
        }
    });
    map.addControl(drawControl);

    renderFixedHouses();

    // Luister naar de snelheids-instellingen (waarde X en schuifje voor rode status)
    db.ref('adminSettings').on('value', function(snapshot) {
        var val = snapshot.val();
        if (val) {
            if (typeof val.ignoreRedStatus === 'boolean') speedSettings.ignoreRedStatus = val.ignoreRedStatus;
            if (val.redThresholdMinutes) speedSettings.redThresholdMinutes = Number(val.redThresholdMinutes);
        }
        window.calculateAndPublishMapState(false);
    });

    // Luister naar de geschiedenis van rode statussen per deelgebied
    db.ref('areaRedHistory').on('value', function(snapshot) {
        areaRedHistory = snapshot.val() || {};
    });

    // Volg ook vossenstatus-updates uit jotihuntSync om rode periodes bij te werken
    db.ref('jotihuntSync/areas').on('value', function(snapshot) {
        var areas = snapshot.val();
        if (areas) {
            var arr = Array.isArray(areas) ? areas : Object.values(areas);
            updateRedStatusTracking(arr);
        }
    });

    // Luister naar ruwe RD-punten en verdeel in deelgebieden óf 'Anders'-punten
    db.ref('rdPoints').on('value', function(snapshot) {
        for (var a in rawRdPointsByArea) rawRdPointsByArea[a] = [];
        rawOtherPoints = [];

        var data = snapshot.val();
        if (data) {
            Object.keys(data).forEach(function(key) {
                var p = data[key];
                if (p && p.latlng && Array.isArray(p.latlng) && p.latlng.length === 2) {
                    var pType = p.pointType || p.baseName || "Hint";
                    if (pType === "Anders" || !p.area) {
                        rawOtherPoints.push({
                            key: key,
                            latlng: p.latlng,
                            rawLocationInput: p.rawLocationInput || "",
                            pointType: "Anders",
                            baseName: "Anders",
                            fullName: "Anders",
                            area: "",
                            time: "",
                            color: p.color || "#34495e",
                            createdTimestamp: p.createdTimestamp || p.createdAt || Date.now()
                        });
                    } else if (p.area && rawRdPointsByArea[p.area]) {
                        rawRdPointsByArea[p.area].push({
                            key: key,
                            latlng: p.latlng,
                            rawLocationInput: p.rawLocationInput || "",
                            pointType: pType,
                            time: p.time || "12:00",
                            datetimeIso: p.datetimeIso || null,
                            pointTimestamp: p.pointTimestamp || null,
                            redDurationBeforeMs: p.redDurationBeforeMs || 0,
                            baseName: p.baseName || pType,
                            fullName: p.fullName || p.baseName,
                            area: p.area,
                            color: p.color || areaColors[p.area] || "#000000",
                            createdTimestamp: p.createdTimestamp || p.createdAt || Date.now()
                        });
                    }
                }
            });
        }
        window.calculateAndPublishMapState(false);
    });

    setInterval(function() {
        window.calculateAndPublishMapState(false);
    }, 30000);

    setTimeout(function() {
        window.syncJotihuntToFirebase(false);
    }, 1500);
    setInterval(function() {
        window.syncJotihuntToFirebase(false);
    }, 45000);
};