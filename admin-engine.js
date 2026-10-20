/* ==========================================================================
   4. ADMIN-ENGINE.JS - CENTRALE REKENMOTOR & BEHEER (ALLEEN VOOR ADMIN)
   Inclusief:
   - Multi-Admin Master Lock
   - RD (met/zonder komma), GPS & Adres-Geocoding (PDOK / OSM)
   - Gekleurde Dropdown (Hint / Hunt / Anders) waarbij 'Anders' geen gebied/tijd heeft
   - Slimme Loopsnelheid: Negeert verplaatsingen > 7 km/u, weegt laatste segment
     voor 50% en overige geldige segmenten voor 50% (Hunt -> fallback Hint -> 6.5 km/u)
   - NIEUW: Toggle voor Loopsnelheid o.b.v. snelste wandelroute (i.p.v. hemelsbreed)
   - NIEUW: Hard Waypoint Pinning tot exact op het coördinaat van elk clubgebouw
   - NIEUW: Verankering van bezochte clubgebouwen langs het pad (tussen RD-punten of na laatste RD-punt)
   - NIEUW: Geen dubbele wegen lopen (backtracking-preventie met 15-minuten omweg-regel)
   - NIEUW: Volledige keten-opbouw voor zowel primaire als alternatieve parallelroute (voorbij cirkel)
   - Handmatige Doel-Clubhuis Lock per deelgebied (via laatste RD-punt popup én Admin-menu)
   - Live Verwachte Vos-positie langs de wandelroute + Snijpunt met cirkelrand
   - Zwevend Admin-paneel met groene/rode statusballetjes en dynamische tekstkleur.
   ========================================================================== */

var rawRdPointsByArea = { "Alpha": [], "Bravo": [], "Delta": [], "Foxtrot": [], "Golf": [], "Hotel": [], "Oscar": [] };
var rawOtherPoints = []; // Voor punten met type "Anders" (zonder deelgebied en tijdstip)
var currentEditingRdKey = null;

/* Cache voor opgehaalde wandelroutes en segmentafstanden zodat we niet onnodig API-calls doen */
var walkingRouteCache = {};
var segmentDistanceCache = {};

/* Houdt per deelgebied bij of de max groeitijd is bereikt voor de UI-statusballetjes */
var areaCappedStatus = {};

/* Instellingen voor snelheidsberekening, cirkelgroei, alternatieve routes, wandelroute-snelheid & locked targets */
var adminSettings = {
    maxCircleGrowthHours: 3,
    maxWalkingSpeedKmh: 7.0,
    defaultSpeedKmh: 6.5,
    showAltQuietRoute: true,
    useRouteSpeedCalculation: false,
    lockedTargets: {} // { "Alpha": "Naam van Clubhuis", ... }
};

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

/* --- 1. WISKUNDE, RICHTINGSVECTOREN, ROUTE-LOGICA & GEOCODING --- */
function getBearing(lat1, lon1, lat2, lon2) {
    var y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
    var x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
    var brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
}

/* Kleinste hoekverschil (0 tot 180 graden) tussen twee kompasrichtingen */
function getAngleDifferenceDeg(angleA, angleB) {
    var diff = Math.abs(angleA - angleB) % 360;
    return diff > 180 ? 360 - diff : diff;
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

/* Kortste afstand in km van een punt P tot een lijnstuk A-B */
function getPointToSegmentDistanceKm(pLat, pLng, aLat, aLng, bLat, bLng) {
    var dAB = getDistanceKm(aLat, aLng, bLat, bLng);
    if (dAB < 0.001) return getDistanceKm(pLat, pLng, aLat, aLng);

    var cosLat = Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    var ax = aLng * cosLat * 111.32, ay = aLat * 111.32;
    var bx = bLng * cosLat * 111.32, by = bLat * 111.32;
    var px = pLng * cosLat * 111.32, py = pLat * 111.32;

    var vx = bx - ax, vy = by - ay;
    var wx = px - ax, wy = py - ay;
    var c1 = wx * vx + wy * vy;
    if (c1 <= 0) return getDistanceKm(pLat, pLng, aLat, aLng);
    var c2 = vx * vx + vy * vy;
    if (c2 <= c1) return getDistanceKm(pLat, pLng, bLat, bLng);

    var b = c1 / c2;
    var projLng = aLng + b * (bLng - aLng);
    var projLat = aLat + b * (bLat - aLat);
    return getDistanceKm(pLat, pLng, projLat, projLng);
}

/* Hulpfunctie: Geeft de timestamp terug waarop een clubhuis als bezocht is gemarkeerd (of 1 als alleen boolean 'true') */
function getHouseVisitedTimestamp(houseName) {
    var safeKey = houseName.replace(/[.#$[\]]/g, '_');
    var val = houseVisitedStatus[safeKey];
    if (!val) return null;
    if (typeof val === 'number' && val > 1000) return val;
    if (typeof val === 'object' && val.visitedAt) return Number(val.visitedAt);
    return 1; // Standaard boolean true
}

/* Verankering van bezochte clubgebouwen langs de historische RD-route:
   Als een clubhuis op 'Bezocht' staat en langs het pad tussen twee opeenvolgende RD-punten ligt,
   wordt dit clubgebouw als verplicht tussenpunt opgenomen zodat de RD-lijn daadwerkelijk tot aan het clubhuis loopt. */
function buildHistoricalCoordsWithVisitedHouses(sortedPoints, visitedHouses) {
    if (!sortedPoints || sortedPoints.length === 0) return [];
    if (sortedPoints.length === 1) return [sortedPoints[0].latlng];

    var resultCoords = [sortedPoints[0].latlng];
    var usedHouses = {};

    for (var i = 0; i < sortedPoints.length - 1; i++) {
        var pA = sortedPoints[i];
        var pB = sortedPoints[i + 1];
        var segDistKm = getDistanceKm(pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1]);
        var tA = getPointTimestampMs(pA);
        var tB = getPointTimestampMs(pB);

        if (visitedHouses && visitedHouses.length > 0 && segDistKm > 0.05) {
            var candidates = [];
            visitedHouses.forEach(function(h) {
                if (usedHouses[h.name]) return;
                var dToSeg = getPointToSegmentDistanceKm(h.lat, h.lng, pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1]);
                var dA = getDistanceKm(pA.latlng[0], pA.latlng[1], h.lat, h.lng);
                var dB = getDistanceKm(h.lat, h.lng, pB.latlng[0], pB.latlng[1]);
                var detourKm = (dA + dB) - segDistKm;

                var ts = getHouseVisitedTimestamp(h.name);
                var timeMatch = (ts && ts > 1000 && ts >= (tA - 15 * 60000) && ts <= (tB + 15 * 60000));

                // Ligt het bezochte clubhuis vlak langs het segment (< 450m) of klopt de bezoek-timestamp binnen een redelijke omweg?
                if ((dToSeg <= 0.45 && detourKm <= 0.85) || (timeMatch && detourKm <= 2.2)) {
                    candidates.push({ house: h, dA: dA });
                }
            });

            candidates.sort(function(a, b) { return a.dA - b.dA; });
            candidates.forEach(function(c) {
                usedHouses[c.house.name] = true;
                resultCoords.push([c.house.lat, c.house.lng]);
            });
        }

        resultCoords.push(pB.latlng);
    }

    return resultCoords;
}

/* Analyseert de reeds BEZOCHTE clubgebouwen in het deelgebied om te bepalen:
   1. Vanuit welke sector/club de vossen zijn gekomen (zodat de route logisch vooruit loopt, weg van bezochte clubs)
   2. Of een bezocht clubhuis ná het laatste RD-punt is afgevinkt óf vlak bij het laatste RD-punt ligt in de looprichting */
function analyzeVisitedHousesContext(lastPointLatLng, lastPointMs, visitedHouses, lineMovementBearingDeg, historicalAnchoredCoords) {
    if (!visitedHouses || visitedHouses.length === 0) {
        return {
            originBearingDeg: null,
            recentVisitedAnchor: null,
            visitedCentroid: null
        };
    }

    var sortedByDistance = visitedHouses.slice().sort(function(a, b) {
        var dA = getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], a.lat, a.lng);
        var dB = getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], b.lat, b.lng);
        return dA - dB;
    });

    var nearestVisited = sortedByDistance[0];
    var nearestDistKm = getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], nearestVisited.lat, nearestVisited.lng);

    // Check of een bezocht clubhuis al eerder in het historische RD-spoor is verankerd
    var alreadyInHistory = function(h) {
        if (!historicalAnchoredCoords || historicalAnchoredCoords.length < 2) return false;
        // Sla het allerlaatste punt (lastPointLatLng) over in de vergelijking
        for (var i = 0; i < historicalAnchoredCoords.length - 1; i++) {
            var c = historicalAnchoredCoords[i];
            if (getDistanceKm(c[0], c[1], h.lat, h.lng) < 0.03) return true;
        }
        return false;
    };

    // 1. Kijk of er een clubhuis expliciet NA het tijdstip van het laatste RD-punt op bezocht is gezet
    var visitedAfterLastRd = null;
    var latestVisitTs = 0;
    visitedHouses.forEach(function(h) {
        if (alreadyInHistory(h)) return;
        var ts = getHouseVisitedTimestamp(h.name);
        var d = getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], h.lat, h.lng);
        if (ts && ts > 1000 && ts > (lastPointMs + 60000) && ts > latestVisitTs && d <= 6.0) {
            latestVisitTs = ts;
            visitedAfterLastRd = h;
        }
    });

    // 2. Als er geen latere timestamp is, maar een bezocht clubgebouw ligt vlak bij het laatste RD-punt (bijv. <= 650m)
    //    én nog niet eerder in het RD-spoor gepasseerd, veranker dit gebouw dan zodat de lijn er echt langs/in loopt!
    if (!visitedAfterLastRd && nearestVisited && !alreadyInHistory(nearestVisited)) {
        if (nearestDistKm > 0.015 && nearestDistKm <= 0.65) {
            if (lineMovementBearingDeg !== null) {
                var bToNearest = getBearing(lastPointLatLng[0], lastPointLatLng[1], nearestVisited.lat, nearestVisited.lng);
                if (getAngleDifferenceDeg(lineMovementBearingDeg, bToNearest) <= 115 || nearestDistKm <= 0.30) {
                    visitedAfterLastRd = nearestVisited;
                }
            } else {
                visitedAfterLastRd = nearestVisited;
            }
        }
    }

    // Bereken het gewogen zwaartepunt (centroid) van de bezochte clubhuizen om de "reeds afgewerkte sector" te kennen
    var sumLat = 0, sumLng = 0, totalW = 0;
    visitedHouses.forEach(function(h) {
        var d = Math.max(0.2, getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], h.lat, h.lng));
        var w = 1 / d;
        sumLat += h.lat * w;
        sumLng += h.lng * w;
        totalW += w;
    });
    var visitedCentroid = totalW > 0 ? [sumLat / totalW, sumLng / totalW] : [nearestVisited.lat, nearestVisited.lng];

    var originBearingDeg = null;
    if (nearestDistKm > 0.05) {
        originBearingDeg = getBearing(nearestVisited.lat, nearestVisited.lng, lastPointLatLng[0], lastPointLatLng[1]);
    }

    return {
        originBearingDeg: originBearingDeg,
        recentVisitedAnchor: visitedAfterLastRd,
        nearestVisited: nearestVisited,
        visitedCentroid: visitedCentroid
    };
}

/* Bepaalt een semi-logische keten van nog niet bezochte clubhuizen die altijd ver genoeg doorloopt
   om de volledige cirkelstraal + extra voorspellingsafstand te dekken (bijv. RD -> Clubhuis 1 -> Clubhuis 2 -> Clubhuis 3). */
function selectSemiLogicalTargetHouses(lastLatLng, movementBearingDeg, unvisitedHouses, visitedContext, lockedHouseName, minRequiredChainMeters) {
    if (!unvisitedHouses || unvisitedHouses.length === 0) return [];

    var requiredDistKm = Math.max(3.5, ((minRequiredChainMeters || 3000) / 1000) * 1.25);

    var effectiveStartLatLng = lastLatLng;
    if (visitedContext && visitedContext.recentVisitedAnchor) {
        effectiveStartLatLng = [visitedContext.recentVisitedAnchor.lat, visitedContext.recentVisitedAnchor.lng];
    }

    var chain = [];
    var remaining = unvisitedHouses.slice();
    var currentPos = effectiveStartLatLng;
    var currentBearing = movementBearingDeg;
    var accumulatedDistKm = getDistanceKm(lastLatLng[0], lastLatLng[1], effectiveStartLatLng[0], effectiveStartLatLng[1]);

    // 1. Eerste doel-clubhuis (check eerst of Admin handmatig een target heeft gelockt)
    var firstTarget = null;
    if (lockedHouseName) {
        firstTarget = remaining.find(function(h) { return h.name === lockedHouseName; }) || null;
    }

    if (!firstTarget) {
        var scoredFirst = remaining.map(function(h) {
            var distKm = getDistanceKm(currentPos[0], currentPos[1], h.lat, h.lng);
            var bearingToHouse = getBearing(currentPos[0], currentPos[1], h.lat, h.lng);
            var penaltyFactor = 1.0;

            if (currentBearing !== null) {
                var angleDiff = getAngleDifferenceDeg(currentBearing, bearingToHouse);
                penaltyFactor *= (0.65 + (angleDiff / 180) * 0.95);
            }

            if (visitedContext) {
                if (visitedContext.originBearingDeg !== null) {
                    var originAngleDiff = getAngleDifferenceDeg(visitedContext.originBearingDeg, bearingToHouse);
                    var visitedFlowMultiplier = 0.80 + (originAngleDiff / 180) * 0.50;
                    penaltyFactor *= visitedFlowMultiplier;
                }
                if (visitedContext.visitedCentroid) {
                    var distFromVisitedCluster = getDistanceKm(visitedContext.visitedCentroid[0], visitedContext.visitedCentroid[1], h.lat, h.lng);
                    var distStartFromCluster = getDistanceKm(visitedContext.visitedCentroid[0], visitedContext.visitedCentroid[1], currentPos[0], currentPos[1]);
                    if (distFromVisitedCluster > distStartFromCluster) {
                        penaltyFactor *= 0.92;
                    }
                }
            }

            return { house: h, distKm: distKm, score: distKm * penaltyFactor };
        });

        scoredFirst.sort(function(a, b) { return a.score - b.score; });
        firstTarget = scoredFirst[0].house;
    }

    chain.push(firstTarget);
    accumulatedDistKm += getDistanceKm(currentPos[0], currentPos[1], firstTarget.lat, firstTarget.lng);
    currentBearing = getBearing(currentPos[0], currentPos[1], firstTarget.lat, firstTarget.lng);
    currentPos = [firstTarget.lat, firstTarget.lng];
    remaining = remaining.filter(function(h) { return h.name !== firstTarget.name; });

    // 2. Bouw de keten door (minimaal 2 clubhuizen indien beschikbaar, en ga door tot voorbij de cirkelstraal, max 4 etappes)
    while (remaining.length > 0 && (chain.length < 2 || accumulatedDistKm < requiredDistKm) && chain.length < 4) {
        var scoredNext = remaining.map(function(h) {
            var distKm = getDistanceKm(currentPos[0], currentPos[1], h.lat, h.lng);
            var bearingToNext = getBearing(currentPos[0], currentPos[1], h.lat, h.lng);
            var angleDiff = currentBearing !== null ? getAngleDifferenceDeg(currentBearing, bearingToNext) : 0;
            // Voorkom terugklappen naar waar we net vandaan kwamen
            var penaltyFactor = 0.70 + (angleDiff / 180) * 1.05;
            return { house: h, distKm: distKm, score: distKm * penaltyFactor };
        });

        scoredNext.sort(function(a, b) { return a.score - b.score; });
        var nextHouse = scoredNext[0].house;

        chain.push(nextHouse);
        accumulatedDistKm += scoredNext[0].distKm;
        currentBearing = getBearing(currentPos[0], currentPos[1], nextHouse.lat, nextHouse.lng);
        currentPos = [nextHouse.lat, nextHouse.lng];
        remaining = remaining.filter(function(h) { return h.name !== nextHouse.name; });
    }

    return chain;
}

/* Hulpfunctie om een route-array netjes te comprimeren voor Firebase */
function simplifyRouteCoords(rawCoords, maxPoints, alreadyLatLng) {
    if (!rawCoords || rawCoords.length === 0) return [];
    var limit = maxPoints || 160;
    var coords = rawCoords.map(function(c) {
        var lat = alreadyLatLng ? c[0] : c[1];
        var lng = alreadyLatLng ? c[1] : c[0];
        return [
            Math.round(lat * 100000) / 100000,
            Math.round(lng * 100000) / 100000
        ];
    });
    if (coords.length > limit) {
        var step = Math.ceil(coords.length / limit);
        var simplified = [];
        for (var j = 0; j < coords.length; j += step) {
            simplified.push(coords[j]);
        }
        var lastOriginal = coords[coords.length - 1];
        var lastSimp = simplified[simplified.length - 1];
        if (lastSimp[0] !== lastOriginal[0] || lastSimp[1] !== lastOriginal[1]) {
            simplified.push(lastOriginal);
        }
        coords = simplified;
    }
    return coords;
}

/* Hard Waypoint Pinning: Dwingt een berekend routepad om exact op het start- én eindcoördinaat
   (bijv. het clubgebouw in een zijstraatje/bospad) te beginnen en eindigen. */
function enforceExactEndpointPinning(coordsLatLng, exactStartLatLng, exactEndLatLng) {
    var pinned = (coordsLatLng && coordsLatLng.length > 0) ? coordsLatLng.slice() : [];
    var sPt = [Math.round(exactStartLatLng[0] * 100000) / 100000, Math.round(exactStartLatLng[1] * 100000) / 100000];
    var ePt = [Math.round(exactEndLatLng[0] * 100000) / 100000, Math.round(exactEndLatLng[1] * 100000) / 100000];

    if (pinned.length === 0) {
        return [sPt, ePt];
    }

    var distStartMeters = getDistanceKm(pinned[0][0], pinned[0][1], sPt[0], sPt[1]) * 1000;
    if (distStartMeters > 2) {
        pinned.unshift(sPt);
    } else {
        pinned[0] = sPt;
    }

    var lastIdx = pinned.length - 1;
    var distEndMeters = getDistanceKm(pinned[lastIdx][0], pinned[lastIdx][1], ePt[0], ePt[1]) * 1000;
    if (distEndMeters > 2) {
        pinned.push(ePt);
    } else {
        pinned[lastIdx] = ePt;
    }

    return pinned;
}

/* Berekent de totale lengte van een polyline in meters */
function getPolylineLengthMeters(coords) {
    if (!coords || coords.length < 2) return 0;
    var total = 0;
    for (var i = 0; i < coords.length - 1; i++) {
        total += getDistanceKm(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]) * 1000;
    }
    return total;
}

/* Controleert hoeveel meter een OSRM-route over N-wegen / drukke provinciale wegen loopt */
function calculateMainRoadPenalty(osrmRouteObj) {
    if (!osrmRouteObj || !osrmRouteObj.legs) return 0;
    var nRoadMeters = 0;
    osrmRouteObj.legs.forEach(function(leg) {
        if (!leg.steps) return;
        leg.steps.forEach(function(step) {
            var name = String(step.name || "");
            var ref = String(step.ref || "");
            var combined = (name + " " + ref).toUpperCase();
            if (/\bN\d{2,3}\b/.test(combined) || combined.includes("PROVINCIALEWEG") || combined.includes("RIJKSWEG")) {
                nRoadMeters += (step.distance || 0);
            }
        });
    });
    return nRoadMeters;
}

/* Berekent de afwijking in meters tussen twee routes om te zien of het echt een andere parallelweg is */
function getRouteSeparationMeters(routeA, routeB) {
    if (!routeA || !routeB || routeA.length < 2 || routeB.length < 2) return 0;
    var sampleIdxs = [
        Math.floor(routeA.length * 0.25),
        Math.floor(routeA.length * 0.50),
        Math.floor(routeA.length * 0.75)
    ];
    var maxMinDist = 0;
    sampleIdxs.forEach(function(idx) {
        var ptA = routeA[idx];
        if (!ptA) return;
        var minDist = Infinity;
        for (var j = 0; j < routeB.length; j++) {
            var d = getDistanceKm(ptA[0], ptA[1], routeB[j][0], routeB[j][1]) * 1000;
            if (d < minDist) minDist = d;
        }
        if (minDist > maxMinDist) maxMinDist = minDist;
    });
    return maxMinDist;
}

/* Berekent hoeveel meter van candidateCoords dubbel loopt (backtracking / overlap) over avoidHistoryCoords */
function computeRouteOverlapMeters(candidateCoords, avoidHistoryCoords) {
    if (!candidateCoords || candidateCoords.length < 2 || !avoidHistoryCoords || avoidHistoryCoords.length < 2) {
        return 0;
    }

    var overlapMeters = 0;
    for (var i = 0; i < candidateCoords.length - 1; i++) {
        var p1 = candidateCoords[i];
        var p2 = candidateCoords[i + 1];
        var segLenMeters = getDistanceKm(p1[0], p1[1], p2[0], p2[1]) * 1000;
        if (segLenMeters < 1) continue;

        var midLat = (p1[0] + p2[0]) / 2;
        var midLng = (p1[1] + p2[1]) / 2;

        // Negeer de eerste/laatste 35 meter direct op het knooppunt/clubhuis zelf (zodat aankomen op het punt mag),
        // maar straf het teruglopen over dezelfde aanloopstraat (> 35m van start/eind) direct af.
        var distFromStart = getDistanceKm(p1[0], p1[1], candidateCoords[0][0], candidateCoords[0][1]) * 1000;
        if (distFromStart < 35) continue;

        var isOverlapping = false;
        for (var j = 0; j < avoidHistoryCoords.length - 1; j++) {
            var h1 = avoidHistoryCoords[j];
            var h2 = avoidHistoryCoords[j + 1];
            var dKm = getPointToSegmentDistanceKm(midLat, midLng, h1[0], h1[1], h2[0], h2[1]);
            if (dKm <= 0.028) { // Binnen 28 meter van een al gelopen weg/pad
                isOverlapping = true;
                break;
            }
        }

        if (isOverlapping) {
            overlapMeters += segLenMeters;
        }
    }
    return overlapMeters;
}

/* Hulpfunctie om een OSRM-wandelroute op te halen voor een coördinaten-string */
async function fetchOsrmFootRoutes(coordString, timeoutMs) {
    var endpoints = [
        `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coordString}?overview=full&geometries=geojson&alternatives=true&steps=true`,
        `https://router.project-osrm.org/route/v1/foot/${coordString}?overview=full&geometries=geojson&alternatives=true&steps=true`
    ];

    for (var i = 0; i < endpoints.length; i++) {
        try {
            var controller = new AbortController();
            var tId = setTimeout(function() { controller.abort(); }, timeoutMs || 4000);
            var res = await fetch(endpoints[i], { signal: controller.signal });
            clearTimeout(tId);

            if (res.ok) {
                var data = await res.json();
                if (data && data.routes && data.routes.length > 0) {
                    return data.routes;
                }
            }
        } catch (err) {
            // Probeer volgende endpoint
        }
    }
    return null;
}

/* Berekent één etappe (van startLatLng naar endLatLng, bijv. van RD-punt naar Clubhuis 1, of van Clubhuis 1 naar Clubhuis 2):
   - Dwingt Hard Waypoint Pinning af tot exact op het clubgebouw
   - Controleert of de route dubbel loopt over avoidHistoryCoords (eerder gelopen RD-route of aanlooproute)
   - Past de 15-minuten regel toe: als dubbel lopen vermeden kan worden met een lus/omweg die <= 15 minuten extra kost
     (o.b.v. de actuele loopsnelheid), kiest de engine automatisch de doorgaande route zonder backtracking! */
async function getBestSegmentRoute(startLatLng, endLatLng, avoidHistoryCoords, speedKmh, preferQuietParallel, primaryReferenceRoute) {
    var effSpeed = Math.max(2.0, Number(speedKmh) || 6.5);
    // 15-minuten regel omgezet naar maximaal toegestane extra omweg-meters: (snelheid km/u * (15 / 60)) * 1000
    var maxDetourMetersFor15Min = (effSpeed * (15 / 60)) * 1000;

    var directCoordStr = `${startLatLng[1]},${startLatLng[0]};${endLatLng[1]},${endLatLng[0]}`;
    var rawRoutes = await fetchOsrmFootRoutes(directCoordStr, 4000);

    var candidates = [];

    if (rawRoutes && rawRoutes.length > 0) {
        rawRoutes.forEach(function(r) {
            var simp = simplifyRouteCoords(r.geometry.coordinates, 95, false);
            var pinned = enforceExactEndpointPinning(simp, startLatLng, endLatLng);
            var distM = getPolylineLengthMeters(pinned);
            var overlapM = computeRouteOverlapMeters(pinned, avoidHistoryCoords);
            var nRoadM = calculateMainRoadPenalty(r);
            candidates.push({
                coords: pinned,
                distMeters: distM,
                overlapMeters: overlapM,
                nRoadMeters: nRoadM
            });
        });
    } else {
        var fallbackPinned = enforceExactEndpointPinning([startLatLng, endLatLng], startLatLng, endLatLng);
        return fallbackPinned;
    }

    var shortestDirectMeters = candidates[0].distMeters;
    var bestDirectOverlap = candidates[0].overlapMeters;

    // Genereer lus-/parallel-kandidaten wanneer:
    // A) De standaardroute dubbel loopt over een al gelopen weg (backtracking > 45m)
    // B) We de alternatieve parallelroute (preferQuietParallel) berekenen en een echte parallelweg zoeken
    var needLoopAlternatives = (bestDirectOverlap > 45) || preferQuietParallel;

    if (needLoopAlternatives) {
        var directDistMeters = getDistanceKm(startLatLng[0], startLatLng[1], endLatLng[0], endLatLng[1]) * 1000;
        if (directDistMeters >= 120 && directDistMeters <= 18000) {
            var midLat = (startLatLng[0] + endLatLng[0]) / 2;
            var midLng = (startLatLng[1] + endLatLng[1]) / 2;
            var mainBearing = getBearing(startLatLng[0], startLatLng[1], endLatLng[0], endLatLng[1]);

            // Kies een zijwaartse offset om via een andere straat/pad het clubgebouw te verlaten of benaderen
            var offsetMeters = Math.min(700, Math.max(160, Math.round(directDistMeters * 0.24)));
            var sideBearings = [(mainBearing + 90) % 360, (mainBearing + 270) % 360];

            // Als het specifiek om backtracking bij vertrek vanaf een clubhuis gaat, plaats het via-punt iets dichter bij het vertrekpunt (35% van de etappe)
            var pivotLat = (bestDirectOverlap > 45 && !preferQuietParallel)
                ? (startLatLng[0] * 0.65 + endLatLng[0] * 0.35)
                : midLat;
            var pivotLng = (bestDirectOverlap > 45 && !preferQuietParallel)
                ? (startLatLng[1] * 0.65 + endLatLng[1] * 0.35)
                : midLng;

            for (var s = 0; s < sideBearings.length; s++) {
                var viaPt = getDestinationLatLng(pivotLat, pivotLng, offsetMeters, sideBearings[s]);
                var viaCoordStr = `${startLatLng[1]},${startLatLng[0]};${viaPt[1]},${viaPt[0]};${endLatLng[1]},${endLatLng[0]}`;
                var viaRoutes = await fetchOsrmFootRoutes(viaCoordStr, 3200);
                if (viaRoutes && viaRoutes.length > 0) {
                    var rVia = viaRoutes[0];
                    var simpVia = simplifyRouteCoords(rVia.geometry.coordinates, 95, false);
                    var pinnedVia = enforceExactEndpointPinning(simpVia, startLatLng, endLatLng);
                    var viaDistM = getPolylineLengthMeters(pinnedVia);
                    var viaOverlapM = computeRouteOverlapMeters(pinnedVia, avoidHistoryCoords);
                    var viaNRoadM = calculateMainRoadPenalty(rVia);
                    candidates.push({
                        coords: pinnedVia,
                        distMeters: viaDistM,
                        overlapMeters: viaOverlapM,
                        nRoadMeters: viaNRoadM
                    });
                }
            }
        }
    }

    // Selecteer de beste kandidaat op basis van de 15-minuten regel en parallel-eisen
    var validCandidates = candidates.filter(function(c) {
        var extraMeters = c.distMeters - shortestDirectMeters;
        return extraMeters <= maxDetourMetersFor15Min;
    });

    if (validCandidates.length === 0) {
        validCandidates = [candidates[0]];
    }

    if (preferQuietParallel && primaryReferenceRoute && primaryReferenceRoute.length >= 2) {
        // Voor de alternatieve parallelroute: kies een kandidaat die daadwerkelijk afwijkt van de primaire route (>= 75m),
        // N-wegen mijdt, niet dubbel loopt én binnen de redelijke omweg valt.
        var separatedCandidates = validCandidates.filter(function(c) {
            return getRouteSeparationMeters(c.coords, primaryReferenceRoute) >= 75;
        });

        var pool = separatedCandidates.length > 0 ? separatedCandidates : validCandidates;
        pool.sort(function(a, b) {
            var scoreA = a.distMeters + (a.overlapMeters * 4.5) + (a.nRoadMeters * 3.5);
            var scoreB = b.distMeters + (b.overlapMeters * 4.5) + (b.nRoadMeters * 3.5);
            return scoreA - scoreB;
        });
        return pool[0].coords;
    }

    // Voor de primaire route: vermijd dubbele wegen zolang de omweg <= 15 minuten kost!
    validCandidates.sort(function(a, b) {
        // Straf elke meter dubbel lopen zwaar af (factor 6), zodat een omweg zonder backtracking altijd wint binnen de 15-minuten grens
        var scoreA = a.distMeters + (a.overlapMeters * 6.0);
        var scoreB = b.distMeters + (b.overlapMeters * 6.0);
        return scoreA - scoreB;
    });

    return validCandidates[0].coords;
}

/* Bouwt een volledige meertraps-wandelroute op langs alle opgegeven waypoints (RD -> Clubhuis 1 -> Clubhuis 2 -> ...),
   waarbij elke etappe exact op het clubgebouw eindigt én onthoudt welke wegen in eerdere etappes al zijn gelopen
   zodat ze bij vertrek niet over dezelfde weg teruglopen. */
async function buildMultiStageWalkRoute(waypointsLatLng, initialHistoryCoords, speedKmh, wantAlternative) {
    if (!waypointsLatLng || waypointsLatLng.length < 2) {
        return { primary: [], alternative: [] };
    }

    var histSignature = (initialHistoryCoords && initialHistoryCoords.length > 0)
        ? initialHistoryCoords.slice(-3).map(function(p) { return `${p[0].toFixed(4)},${p[1].toFixed(4)}`; }).join('|')
        : 'NOHIST';

    var speedBucket = Math.round((Number(speedKmh) || 6.5) * 2) / 2;
    var cacheKey = waypointsLatLng.map(function(pt) {
        return `${pt[0].toFixed(5)},${pt[1].toFixed(5)}`;
    }).join('_') + `_H:${histSignature}_S:${speedBucket}_ALT:${wantAlternative ? 1 : 0}`;

    if (walkingRouteCache[cacheKey]) {
        return walkingRouteCache[cacheKey];
    }

    var primaryFullCoords = [];
    var altFullCoords = [];

    // Geheugen van reeds gelopen wegen voor de primaire route (start met de historische RD-route)
    var primaryAvoidHistory = (initialHistoryCoords && initialHistoryCoords.length >= 2)
        ? initialHistoryCoords.slice()
        : [];

    // Geheugen van reeds gelopen wegen voor de alternatieve parallelroute
    var altAvoidHistory = (initialHistoryCoords && initialHistoryCoords.length >= 2)
        ? initialHistoryCoords.slice()
        : [];

    var stagePrimaryRoutes = [];

    // 1. Bouw de primaire route etappe voor etappe op
    for (var i = 0; i < waypointsLatLng.length - 1; i++) {
        var segStart = waypointsLatLng[i];
        var segEnd = waypointsLatLng[i + 1];

        var segPrimary = await getBestSegmentRoute(
            segStart,
            segEnd,
            primaryAvoidHistory,
            speedKmh,
            false,
            null
        );

        stagePrimaryRoutes.push(segPrimary);

        if (primaryFullCoords.length === 0) {
            primaryFullCoords = segPrimary.slice();
        } else {
            primaryFullCoords = primaryFullCoords.concat(segPrimary.slice(1));
        }

        // Voeg de zojuist gelopen aanlooproute naar dit clubgebouw toe aan het geheugen voor de volgende etappe!
        primaryAvoidHistory = primaryAvoidHistory.concat(segPrimary);
    }

    // 2. Bouw (indien ingeschakeld) de alternatieve parallelroute over de VOLLEDIGE keten van clubgebouwen op
    if (wantAlternative) {
        var anyDifference = false;
        for (var j = 0; j < waypointsLatLng.length - 1; j++) {
            var altStart = waypointsLatLng[j];
            var altEnd = waypointsLatLng[j + 1];
            var refPrimarySeg = stagePrimaryRoutes[j];

            var segAlt = await getBestSegmentRoute(
                altStart,
                altEnd,
                altAvoidHistory,
                speedKmh,
                true,
                refPrimarySeg
            );

            if (getRouteSeparationMeters(segAlt, refPrimarySeg) >= 50) {
                anyDifference = true;
            }

            if (altFullCoords.length === 0) {
                altFullCoords = segAlt.slice();
            } else {
                altFullCoords = altFullCoords.concat(segAlt.slice(1));
            }

            altAvoidHistory = altAvoidHistory.concat(segAlt);
        }

        if (!anyDifference) {
            altFullCoords = [];
        }
    }

    var finalResult = {
        primary: simplifyRouteCoords(primaryFullCoords, 220, true),
        alternative: altFullCoords.length >= 2 ? simplifyRouteCoords(altFullCoords, 220, true) : []
    };

    walkingRouteCache[cacheKey] = finalResult;
    return finalResult;
}

/* Haalt de snelste wandelafstand in kilometers op tussen twee punten (met cache) voor de wandelroute-snelheidsberekening */
async function getFastestWalkingDistanceKmBetweenPoints(lat1, lng1, lat2, lng2) {
    var straightKm = getDistanceKm(lat1, lng1, lat2, lng2);
    // Als twee punten vrijwel op elkaar liggen of onrealistisch ver uit elkaar (> 25 km), bespaar een API-call
    if (straightKm < 0.03 || straightKm > 25.0) {
        return straightKm;
    }

    var key = `${lat1.toFixed(5)},${lng1.toFixed(5)}_${lat2.toFixed(5)},${lng2.toFixed(5)}`;
    if (segmentDistanceCache[key] !== undefined) {
        return segmentDistanceCache[key];
    }

    var coordStr = `${lng1},${lat1};${lng2},${lat2}`;
    var routes = await fetchOsrmFootRoutes(coordStr, 3000);
    if (routes && routes.length > 0 && routes[0].distance > 0) {
        var walkKm = routes[0].distance / 1000;
        segmentDistanceCache[key] = walkKm;
        return walkKm;
    }

    segmentDistanceCache[key] = straightKm;
    return straightKm;
}

/* Berekent het exacte snijpunt waar een looproute en de rand van de groeiende cirkel elkaar ontmoeten */
function findRouteCircleIntersection(centerLatLng, radiusMeters, routeCoords) {
    if (!routeCoords || routeCoords.length < 2 || radiusMeters <= 0) return null;

    var cLat = centerLatLng[0];
    var cLng = centerLatLng[1];

    for (var i = 0; i < routeCoords.length - 1; i++) {
        var p1 = routeCoords[i];
        var p2 = routeCoords[i + 1];

        var d1 = getDistanceKm(cLat, cLng, p1[0], p1[1]) * 1000;
        var d2 = getDistanceKm(cLat, cLng, p2[0], p2[1]) * 1000;

        if ((d1 <= radiusMeters && d2 >= radiusMeters) || (d1 >= radiusMeters && d2 <= radiusMeters)) {
            if (Math.abs(d2 - d1) < 0.001) {
                return [p1[0], p1[1]];
            }
            var ratio = (radiusMeters - d1) / (d2 - d1);
            ratio = Math.max(0, Math.min(1, ratio));
            var interLat = p1[0] + ratio * (p2[0] - p1[0]);
            var interLng = p1[1] + ratio * (p2[1] - p1[1]);
            return [
                Math.round(interLat * 100000) / 100000,
                Math.round(interLng * 100000) / 100000
            ];
        }
    }
    return null;
}

/* Berekent waar de vos zich LIVE op de wandelroute bevindt door de afgelegde afstand (tijd * gem. snelheid)
   exact langs de bochten van de berekende wandelroute uit te zetten */
function getPointAlongRouteByDistance(routeCoords, targetDistanceMeters) {
    if (!routeCoords || routeCoords.length === 0) return null;
    if (routeCoords.length === 1 || targetDistanceMeters <= 0) {
        return {
            coord: routeCoords[0],
            distanceWalkedMeters: 0,
            reachedEnd: false
        };
    }

    var accumulatedMeters = 0;

    for (var i = 0; i < routeCoords.length - 1; i++) {
        var p1 = routeCoords[i];
        var p2 = routeCoords[i + 1];
        var segMeters = getDistanceKm(p1[0], p1[1], p2[0], p2[1]) * 1000;

        if (accumulatedMeters + segMeters >= targetDistanceMeters) {
            var remaining = targetDistanceMeters - accumulatedMeters;
            var ratio = segMeters > 0 ? (remaining / segMeters) : 0;
            ratio = Math.max(0, Math.min(1, ratio));
            var lat = p1[0] + ratio * (p2[0] - p1[0]);
            var lng = p1[1] + ratio * (p2[1] - p1[1]);
            return {
                coord: [
                    Math.round(lat * 100000) / 100000,
                    Math.round(lng * 100000) / 100000
                ],
                distanceWalkedMeters: Math.round(targetDistanceMeters),
                reachedEnd: false
            };
        }
        accumulatedMeters += segMeters;
    }

    var lastPt = routeCoords[routeCoords.length - 1];
    return {
        coord: [lastPt[0], lastPt[1]],
        distanceWalkedMeters: Math.round(accumulatedMeters),
        reachedEnd: true
    };
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

/* Zet RD, GPS óf een gekopieerd adres om naar [lat, lng] */
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

/* --- 2. SLIMME SNELHEIDSBEREKENING (MAX 7 KM/U FILTER, 50/50 WEGING & WANDELROUTE-OPTIE) --- */
async function getValidSpeedSegments(pts, useWalkRouteDistance) {
    var maxAllowedKmh = Number(adminSettings.maxWalkingSpeedKmh) || 7.0;
    var segments = [];

    for (var i = 0; i < pts.length - 1; i++) {
        var pA = pts[i];
        var pB = pts[i + 1];
        var t1 = getPointTimestampMs(pA);
        var t2 = getPointTimestampMs(pB);

        if (t2 <= t1) continue;

        var hours = (t2 - t1) / 3600000;
        if (hours <= 0) continue;

        var straightKm = getDistanceKm(pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1]);
        // Als zelfs hemelsbreed al > 7.5 km/u is, kan een wandelroute alleen maar nóg sneller zijn -> direct overslaan
        if ((straightKm / hours) > (maxAllowedKmh + 0.5)) continue;

        var distKm = useWalkRouteDistance
            ? await getFastestWalkingDistanceKmBetweenPoints(pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1])
            : straightKm;

        var kmh = distKm / hours;
        if (kmh <= maxAllowedKmh && kmh > 0) {
            segments.push(kmh);
        }
    }
    return segments;
}

function computeWeightedSpeedFromSegments(segments) {
    if (!segments || segments.length === 0) return null;
    if (segments.length === 1) {
        return segments[0];
    }
    var lastSegSpeed = segments[segments.length - 1];
    var prevSegments = segments.slice(0, segments.length - 1);
    var sumPrev = prevSegments.reduce(function(acc, val) { return acc + val; }, 0);
    var avgPrev = sumPrev / prevSegments.length;

    return (0.50 * lastSegSpeed) + (0.50 * avgPrev);
}

async function calculateAreaWalkingSpeed(areaPoints) {
    var defaultKmh = Number(adminSettings.defaultSpeedKmh) || 6.5;
    var useRoute = !!adminSettings.useRouteSpeedCalculation;
    var modeSuffix = useRoute ? " • Route" : "";

    var huntPoints = areaPoints.filter(function(p) {
        return (p.pointType || p.baseName) === "Hunt";
    });

    var huntSegments = await getValidSpeedSegments(huntPoints, useRoute);
    if (huntSegments.length > 0) {
        var rawHuntSpeed = computeWeightedSpeedFromSegments(huntSegments);
        var clampedHunt = Math.min(7.0, Math.max(0.5, rawHuntSpeed));
        var displayHunt = Math.round(clampedHunt * 10) / 10;
        return {
            speedKmh: clampedHunt,
            speedText: `~${displayHunt} km/u (Hunt${modeSuffix})`
        };
    }

    var huntAndHintPoints = areaPoints.filter(function(p) {
        var t = p.pointType || p.baseName || "Hint";
        return t === "Hunt" || t === "Hint";
    });

    var combinedSegments = await getValidSpeedSegments(huntAndHintPoints, useRoute);
    if (combinedSegments.length > 0) {
        var rawCombinedSpeed = computeWeightedSpeedFromSegments(combinedSegments);
        var clampedCombined = Math.min(7.0, Math.max(0.5, rawCombinedSpeed));
        var displayCombined = Math.round(clampedCombined * 10) / 10;
        return {
            speedKmh: clampedCombined,
            speedText: `~${displayCombined} km/u (incl. Hint${modeSuffix})`
        };
    }

    return {
        speedKmh: defaultKmh,
        speedText: `~${defaultKmh} km/u (Standaard)`
    };
}

/* Handmatig een specifiek doel-clubhuis locken (of op Automatisch zetten) vanuit Admin-paneel of Laatste RD-punt popup */
window.setAreaLockedTarget = function(area, houseName) {
    if (!isAdmin || !area) return;
    var cleanTarget = (houseName && houseName.trim() !== "") ? houseName.trim() : null;

    if (!adminSettings.lockedTargets) adminSettings.lockedTargets = {};
    if (cleanTarget) {
        adminSettings.lockedTargets[area] = cleanTarget;
    } else {
        delete adminSettings.lockedTargets[area];
    }

    db.ref('adminSettings/lockedTargets/' + area).set(cleanTarget).then(function() {
        window.calculateAndPublishMapState(true);
    });
};

/* Update het Admin Instellingen Paneel (statusballetjes, tekstkleuren & doel-clubhuis dropdowns per actief gebied) */
function updateAdminSettingsPanelStatus() {
    var statusDot = document.getElementById('admin-max-hours-status-dot');
    var labelEl = document.getElementById('admin-max-hours-label');
    var subtextEl = document.getElementById('admin-max-hours-subtext');
    var altRouteDot = document.getElementById('admin-alt-route-status-dot');
    var altRouteToggle = document.getElementById('admin-alt-route-toggle');
    var routeSpeedDot = document.getElementById('admin-route-speed-status-dot');
    var routeSpeedToggle = document.getElementById('admin-route-speed-toggle');
    var areaStatusList = document.getElementById('admin-area-growth-list');

    if (!statusDot || !labelEl || !subtextEl) return;

    var activeAreas = Object.keys(areaCappedStatus);
    var anyCapped = activeAreas.some(function(a) { return areaCappedStatus[a].isCapped; });

    // 1. Balletje bij Max. groeitijd: groen als max groeitijd nog niet gehaald is, rood als deze bereikt is
    statusDot.className = 'admin-status-dot ' + (anyCapped ? 'status-dot-red' : 'status-dot-green');
    statusDot.title = anyCapped
        ? 'Maximale groeitijd is bereikt voor één of meer gebieden'
        : 'Groei actief (maximale groeitijd nog niet bereikt)';

    if (anyCapped) {
        labelEl.classList.add('capped-reached');
        subtextEl.classList.add('capped-reached');
    } else {
        labelEl.classList.remove('capped-reached');
        subtextEl.classList.remove('capped-reached');
    }

    // 2. Balletje & checkbox voor Alternatieve Parallel/N-weg-mijdende Route
    if (altRouteToggle && document.activeElement !== altRouteToggle) {
        altRouteToggle.checked = !!adminSettings.showAltQuietRoute;
    }
    if (altRouteDot) {
        altRouteDot.className = 'admin-status-dot ' + (adminSettings.showAltQuietRoute ? 'status-dot-green' : 'status-dot-red');
        altRouteDot.title = adminSettings.showAltQuietRoute ? 'Alternatieve route ingeschakeld' : 'Alternatieve route uitgeschakeld';
    }

    // 3. Balletje & checkbox voor Loopsnelheid o.b.v. snelste wandelroute (i.p.v. hemelsbreed)
    if (routeSpeedToggle && document.activeElement !== routeSpeedToggle) {
        routeSpeedToggle.checked = !!adminSettings.useRouteSpeedCalculation;
    }
    if (routeSpeedDot) {
        routeSpeedDot.className = 'admin-status-dot ' + (adminSettings.useRouteSpeedCalculation ? 'status-dot-green' : 'status-dot-red');
        routeSpeedDot.title = adminSettings.useRouteSpeedCalculation
            ? 'Loopsnelheid o.b.v. wandelroute ingeschakeld'
            : 'Loopsnelheid o.b.v. hemelsbrede afstand (standaard)';
    }

    // 4. Overzicht per actief deelgebied met eigen groen/rood balletje én Doel-Clubhuis Lock dropdown
    if (areaStatusList) {
        if (activeAreas.length === 0) {
            areaStatusList.style.display = 'none';
            areaStatusList.innerHTML = '';
        } else {
            areaStatusList.style.display = 'flex';
            areaStatusList.innerHTML = activeAreas.map(function(a) {
                var st = areaCappedStatus[a];
                var dotCls = st.isCapped ? 'status-dot-red' : 'status-dot-green';
                var txtCls = st.isCapped ? 'admin-area-status-item capped-reached' : 'admin-area-status-item';

                var areaHouses = allLocations.filter(function(l) { return l.area === a; });
                var unvisited = areaHouses.filter(function(h) {
                    var sKey = h.name.replace(/[.#$[\]]/g, '_');
                    return !houseVisitedStatus[sKey];
                });
                var lockedName = (adminSettings.lockedTargets && adminSettings.lockedTargets[a]) ? adminSettings.lockedTargets[a] : "";

                var optionsHtml = `<option value="">🤖 Auto (${st.autoTargetName || 'Slim'})</option>`;
                unvisited.forEach(function(h) {
                    var sel = (h.name === lockedName) ? 'selected' : '';
                    optionsHtml += `<option value="${h.name.replace(/"/g, '&quot;')}" ${sel}>🔒 ${h.name}</option>`;
                });

                return `<div class="${txtCls}" style="flex-direction:column; align-items:stretch; gap:3px; padding:3px 0;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span class="admin-status-dot ${dotCls}"></span>
                        <span><b>${a}</b>: ${st.statusLabel}</span>
                    </div>
                    <select class="admin-target-lock-select" onchange="window.setAreaLockedTarget('${a}', this.value)" title="Kies of lock doel-clubhuis voor ${a}">
                        ${optionsHtml}
                    </select>
                </div>`;
            }).join('');
        }
    }
}

/* --- 3. CENTRALE BEREKENING & PUBLICATIE NAAR FIREBASE --- */
var isCalculatingMapState = false;

window.calculateAndPublishMapState = async function(forceManual = false) {
    if (!isAdmin) return;
    if (!isMasterAdmin && !forceManual) {
        updateAdminSettingsPanelStatus();
        return;
    }
    if (isCalculatingMapState && !forceManual) return;

    isCalculatingMapState = true;

    try {
        var nowMs = Date.now();
        var computedAreas = {};
        var newAreaCappedStatus = {};

        var maxGrowthHours = Number(adminSettings.maxCircleGrowthHours);
        if (isNaN(maxGrowthHours) || maxGrowthHours <= 0) maxGrowthHours = 3;
        var maxGrowthSeconds = maxGrowthHours * 3600;

        for (var area in rawRdPointsByArea) {
            var points = rawRdPointsByArea[area].slice();
            if (points.length === 0) continue;

            points.sort(function(a, b) {
                return getPointTimestampMs(a) - getPointTimestampMs(b);
            });
            var lastPoint = points[points.length - 1];
            var lastPtMs = getPointTimestampMs(lastPoint);

            var speedResult = await calculateAreaWalkingSpeed(points);
            var calculatedSpeedKmh = speedResult.speedKmh;
            var speedText = speedResult.speedText;

            // 1. Splits de clubgebouwen van dit deelgebied in BEZOCHT en ONBEZOCHT
            var areaHouses = allLocations.filter(function(l) { return l.area === area; });
            var visitedHouses = [];
            var unvisitedHouses = [];

            areaHouses.forEach(function(h) {
                var safeKey = h.name.replace(/[.#$[\]]/g, '_');
                if (houseVisitedStatus[safeKey]) {
                    visitedHouses.push(h);
                } else {
                    unvisitedHouses.push(h);
                }
            });

            // 2. Veranker bezochte clubgebouwen die langs het historische RD-spoor liggen
            var historicalAnchoredCoords = buildHistoricalCoordsWithVisitedHouses(points, visitedHouses);

            // 3. Bepaal de pure looprichting van de vossen op basis van hun RD-lijn (inclusief verankerde bezochte clubs)
            var lineMovementBearingDeg = null;
            if (historicalAnchoredCoords.length >= 2) {
                var mSin = 0, mCos = 0, mWeight = 0;
                var cA = historicalAnchoredCoords[historicalAnchoredCoords.length - 2];
                var cB = historicalAnchoredCoords[historicalAnchoredCoords.length - 1];
                var b1 = getBearing(cA[0], cA[1], cB[0], cB[1]) * Math.PI / 180;
                mSin += 0.80 * Math.sin(b1); mCos += 0.80 * Math.cos(b1); mWeight += 0.80;

                if (historicalAnchoredCoords.length >= 3) {
                    var cA2 = historicalAnchoredCoords[historicalAnchoredCoords.length - 3];
                    var cB2 = historicalAnchoredCoords[historicalAnchoredCoords.length - 2];
                    var b2 = getBearing(cA2[0], cA2[1], cB2[0], cB2[1]) * Math.PI / 180;
                    mSin += 0.20 * Math.sin(b2); mCos += 0.20 * Math.cos(b2); mWeight += 0.20;
                }
                if (mWeight > 0) {
                    var avgMoveRad = Math.atan2(mSin / mWeight, mCos / mWeight);
                    lineMovementBearingDeg = ((avgMoveRad * 180 / Math.PI) + 360) % 360;
                }
            }

            // 4. Analyseer de al BEZOCHTE clubgebouwen (inclusief een eventueel bezocht clubgebouw vlak na/bij het laatste RD-punt)
            var visitedContext = analyzeVisitedHousesContext(
                lastPoint.latlng,
                lastPtMs,
                visitedHouses,
                lineMovementBearingDeg,
                historicalAnchoredCoords
            );

            // Bereken alvast de actuele cirkelstraal zodat de keten van doel-clubhuizen altijd voorbij de cirkel loopt
            var isFuture = (lastPtMs > nowMs);
            var rawSecondsPassed = isFuture ? 0 : Math.floor((nowMs - lastPtMs) / 1000);
            var isCappedByAge = (!isFuture && rawSecondsPassed >= maxGrowthSeconds);
            var effectiveSecondsPassed = isCappedByAge ? maxGrowthSeconds : rawSecondsPassed;

            var effectiveSpeedKmh = calculatedSpeedKmh !== null ? calculatedSpeedKmh : 6.5;
            var currentRadiusMeters = 1;
            if (!isFuture) {
                var metersPerSecond = (effectiveSpeedKmh * 1000) / 3600;
                currentRadiusMeters = Math.max(1, Math.round(1 + (effectiveSecondsPassed * metersPerSecond)));
            }

            // Controleer of er voor dit gebied een handmatig gelockt doel-clubhuis is ingesteld
            var lockedTargetName = (adminSettings.lockedTargets && adminSettings.lockedTargets[area])
                ? adminSettings.lockedTargets[area]
                : null;

            if (lockedTargetName && !unvisitedHouses.some(function(h) { return h.name === lockedTargetName; })) {
                lockedTargetName = null;
            }

            // Selecteer de semi-logische keten van onbezochte clubhuizen (dekt altijd de volledige cirkelstraal + extra voorspellingsafstand)
            var targetHousesChain = selectSemiLogicalTargetHouses(
                lastPoint.latlng,
                lineMovementBearingDeg,
                unvisitedHouses,
                visitedContext,
                lockedTargetName,
                currentRadiusMeters + 2500
            );
            var primaryTargetHouse = targetHousesChain.length > 0 ? targetHousesChain[0] : null;

            // 5. Bereken de gecombineerde richtingshoek voor de gradenhoek-pijlen op de cirkel
            var bearingDeg = null;
            if (points.length >= 2 || visitedContext.originBearingDeg !== null || primaryTargetHouse) {
                var sumSin = 0, sumCos = 0, totalWeight = 0;

                if (points.length >= 2) {
                    var pPrev = points[points.length - 2];
                    var pCurr = points[points.length - 1];
                    var bLast = getBearing(pPrev.latlng[0], pPrev.latlng[1], pCurr.latlng[0], pCurr.latlng[1]) * Math.PI / 180;
                    sumSin += 0.40 * Math.sin(bLast); sumCos += 0.40 * Math.cos(bLast); totalWeight += 0.40;
                }

                if (points.length >= 3) {
                    var pPrev2 = points[points.length - 3];
                    var pPrev1 = points[points.length - 2];
                    var bPrev = getBearing(pPrev2.latlng[0], pPrev2.latlng[1], pPrev1.latlng[0], pPrev1.latlng[1]) * Math.PI / 180;
                    sumSin += 0.10 * Math.sin(bPrev); sumCos += 0.10 * Math.cos(bPrev); totalWeight += 0.10;
                }

                if (visitedContext.originBearingDeg !== null) {
                    var bVisitedOrigin = visitedContext.originBearingDeg * Math.PI / 180;
                    sumSin += 0.20 * Math.sin(bVisitedOrigin); sumCos += 0.20 * Math.cos(bVisitedOrigin); totalWeight += 0.20;
                }

                if (primaryTargetHouse) {
                    var bHouse = getBearing(lastPoint.latlng[0], lastPoint.latlng[1], primaryTargetHouse.lat, primaryTargetHouse.lng) * Math.PI / 180;
                    sumSin += 0.35 * Math.sin(bHouse); sumCos += 0.35 * Math.cos(bHouse); totalWeight += 0.35;
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
                    isLatest: isLatest,
                    lockedTarget: isLatest ? (lockedTargetName || "") : "",
                    autoTarget: isLatest && primaryTargetHouse ? primaryTargetHouse.name : ""
                };
            });

            var baseAreaColor = areaColors[area] || "#e74c3c";
            var circleDisplayColor = isCappedByAge ? "#7f8c8d" : baseAreaColor;

            var distFormatted = currentRadiusMeters >= 1000
                ? (currentRadiusMeters / 1000).toFixed(1) + ' km'
                : currentRadiusMeters + ' m';

            var badgeText = isFuture
                ? `🎯 ${area}: 1 m (in toekomst)`
                : (isCappedByAge
                    ? `⏸️ ${area}: ${distFormatted} (max ${maxGrowthHours}u bereikt)`
                    : `🎯 ${area}: ${distFormatted}`);

            newAreaCappedStatus[area] = {
                isCapped: isCappedByAge,
                statusLabel: isCappedByAge ? `Max (${maxGrowthHours}u) bereikt` : `Groeit (${distFormatted})`,
                autoTargetName: primaryTargetHouse ? primaryTargetHouse.name : "Geen"
            };

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

            // 6. Bereken zowel de primaire voorspellende looproute als de alternatieve parallelroute over de volledige keten
            //    met Hard Waypoint Pinning op elk clubgebouw én 15-minuten backtracking-preventie
            var estimatedWalkRoute = [];
            var alternativeWalkRoute = [];
            var estimatedTargetHouseName = "";
            var visitedOriginHouseName = visitedContext.nearestVisited ? visitedContext.nearestVisited.name : "";
            var circleIntersectionPoint = null;
            var liveExpectedFoxPoint = null;
            var altLiveExpectedFoxPoint = null;

            if (targetHousesChain.length > 0) {
                var waypoints = [lastPoint.latlng];
                // Als een clubhuis vlak bij of ná het laatste RD-punt op bezocht staat, veranker dit als eerste verplichte tussenpunt
                if (visitedContext.recentVisitedAnchor) {
                    waypoints.push([visitedContext.recentVisitedAnchor.lat, visitedContext.recentVisitedAnchor.lng]);
                }
                targetHousesChain.forEach(function(h) {
                    waypoints.push([h.lat, h.lng]);
                });

                var lockPrefix = lockedTargetName ? "🔒 " : "";
                var chainLabelParts = [];
                if (visitedContext.recentVisitedAnchor) {
                    chainLabelParts.push("✔️ " + visitedContext.recentVisitedAnchor.name);
                }
                targetHousesChain.forEach(function(h) {
                    chainLabelParts.push(h.name);
                });
                estimatedTargetHouseName = lockPrefix + chainLabelParts.join(" ➔ ");

                var routesObj = await buildMultiStageWalkRoute(
                    waypoints,
                    historicalAnchoredCoords,
                    effectiveSpeedKmh,
                    !!adminSettings.showAltQuietRoute
                );
                estimatedWalkRoute = routesObj.primary || [];
                alternativeWalkRoute = routesObj.alternative || [];

                if (!isFuture && estimatedWalkRoute && estimatedWalkRoute.length >= 2) {
                    circleIntersectionPoint = findRouteCircleIntersection(
                        lastPoint.latlng,
                        currentRadiusMeters,
                        estimatedWalkRoute
                    );

                    var walkedPos = getPointAlongRouteByDistance(estimatedWalkRoute, currentRadiusMeters);
                    if (walkedPos && walkedPos.coord) {
                        liveExpectedFoxPoint = {
                            coord: walkedPos.coord,
                            distanceMeters: walkedPos.distanceWalkedMeters,
                            speedText: speedText,
                            targetHouse: primaryTargetHouse ? primaryTargetHouse.name : "",
                            isLocked: !!lockedTargetName,
                            visitedOriginHouse: visitedOriginHouseName,
                            reachedEnd: walkedPos.reachedEnd
                        };
                    }
                }

                if (!isFuture && alternativeWalkRoute && alternativeWalkRoute.length >= 2) {
                    var altWalkedPos = getPointAlongRouteByDistance(alternativeWalkRoute, currentRadiusMeters);
                    if (altWalkedPos && altWalkedPos.coord) {
                        altLiveExpectedFoxPoint = {
                            coord: altWalkedPos.coord,
                            distanceMeters: altWalkedPos.distanceWalkedMeters,
                            speedText: speedText,
                            targetHouse: primaryTargetHouse ? primaryTargetHouse.name : ""
                        };
                    }
                }
            }

            computedAreas[area] = {
                points: processedPoints,
                routeCoords: historicalAnchoredCoords.length >= 2 ? historicalAnchoredCoords : [],
                lineColor: (area === "Oscar") ? "#003399" : (areaColors[area] || "#000000"),
                geofence: {
                    center: lastPoint.latlng,
                    radiusMeters: currentRadiusMeters,
                    color: circleDisplayColor,
                    areaColor: baseAreaColor,
                    isCappedByAge: isCappedByAge,
                    badgeText: badgeText,
                    arrows: arrows,
                    estimatedWalkRoute: estimatedWalkRoute,
                    alternativeWalkRoute: alternativeWalkRoute,
                    estimatedTargetHouse: estimatedTargetHouseName,
                    visitedOriginHouse: visitedOriginHouseName,
                    lockedTarget: lockedTargetName || "",
                    intersectionPoint: circleIntersectionPoint,
                    liveExpectedFoxPoint: liveExpectedFoxPoint,
                    altLiveExpectedFoxPoint: altLiveExpectedFoxPoint
                }
            };
        }

        areaCappedStatus = newAreaCappedStatus;
        updateAdminSettingsPanelStatus();

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

        await db.ref('computedMapState').set({
            updatedAt: Date.now(),
            masterId: adminSessionId,
            areas: computedAreas,
            otherPoints: processedOtherPoints
        });
    } finally {
        isCalculatingMapState = false;
    }
};

/* --- 4. RD-PUNT MODAL & ZWEVEND ADMIN-INSTELLINGEN PANEEL OP DE KAART --- */
function injectAdminUI() {
    if (document.getElementById('rd-modal-overlay')) return;

    var style = document.createElement('style');
    style.innerHTML = `
        /* Modal voor RD-punten toevoegen/bewerken */
        #rd-modal-overlay {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(26, 37, 47, 0.85); backdrop-filter: blur(3px);
            z-index: 3000; justify-content: center; align-items: center; padding: 10px;
        }
        #rd-modal-box {
            background: #2c3e50; color: #ecf0f1; width: 100%; max-width: 380px;
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
        .rd-modal-actions { display: flex; gap: 8px; margin-top: 4px; }
        .rd-btn {
            flex: 1; padding: 9px; border: none; border-radius: 5px;
            font-weight: bold; font-size: 0.85rem; cursor: pointer; color: white;
        }
        .rd-btn-save { background: #27ae60; }
        .rd-btn-save:disabled { background: #7f8c8d; cursor: wait; }
        .rd-btn-cancel { background: #7f8c8d; }

        /* Zwevend, versleepbaar & minimaliseerbaar Admin Instellingen Paneel op de basispagina */
        #admin-settings-panel {
            position: absolute; top: 12px; left: 54px; z-index: 950;
            background: #2c3e50; color: #ecf0f1;
            border: 1px solid #4a6278; border-radius: 8px;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
            width: 274px; max-width: 86vw;
            font-size: 0.8rem; user-select: none; touch-action: none;
            overflow: hidden;
        }
        #admin-settings-header {
            background: #1a252f; color: #ffffff;
            padding: 7px 10px; font-weight: bold; font-size: 0.82rem;
            display: flex; justify-content: space-between; align-items: center;
            cursor: move; border-bottom: 1px solid #4a6278;
        }
        #admin-settings-min-btn {
            background: #34495e; color: #ecf0f1; border: 1px solid #4a6278;
            border-radius: 4px; font-size: 0.85rem; font-weight: bold;
            cursor: pointer; padding: 1px 7px; line-height: 1.2;
        }
        #admin-settings-body {
            padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
            max-height: 75vh; overflow-y: auto;
        }
        .admin-setting-row {
            display: flex; justify-content: space-between; align-items: center; gap: 8px;
        }
        .admin-setting-label-wrap {
            display: flex; align-items: center; gap: 7px; flex: 1;
        }
        .admin-setting-row label {
            font-size: 0.76rem; color: #95a5a6; font-weight: 600; line-height: 1.25;
            transition: color 0.2s ease; cursor: pointer;
        }
        .admin-setting-row label.capped-reached {
            color: #dcdde1 !important;
        }
        .admin-status-dot {
            width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
            display: inline-block; transition: background-color 0.2s ease, box-shadow 0.2s ease;
        }
        .status-dot-green {
            background-color: #2ecc71;
            box-shadow: 0 0 5px rgba(46, 204, 113, 0.75);
        }
        .status-dot-red {
            background-color: #e74c3c;
            box-shadow: 0 0 5px rgba(231, 76, 60, 0.85);
        }
        #admin-max-hours-input {
            width: 60px; padding: 5px 6px; border-radius: 5px;
            border: 1px solid #4a6278; background: #34495e; color: #ffffff;
            font-size: 0.85rem; font-weight: bold; text-align: center; outline: none;
        }
        #admin-max-hours-input:focus { border-color: #3498db; }
        #admin-alt-route-toggle, #admin-route-speed-toggle {
            width: 17px; height: 17px; cursor: pointer; accent-color: #2ecc71;
        }
        .admin-setting-subtext {
            font-size: 0.7rem; color: #95a5a6; line-height: 1.25;
            transition: color 0.2s ease;
        }
        .admin-setting-subtext.capped-reached {
            color: #dcdde1 !important;
        }
        .admin-divider {
            border: 0; border-top: 1px solid #3d566e; margin: 2px 0;
        }
        #admin-area-growth-list {
            display: none; flex-direction: column; gap: 5px;
            border-top: 1px solid #3d566e; padding-top: 6px; margin-top: 2px;
        }
        .admin-area-status-item {
            display: flex; align-items: center; gap: 6px;
            font-size: 0.72rem; color: #95a5a6; font-weight: 600;
        }
        .admin-area-status-item.capped-reached {
            color: #dcdde1 !important;
        }
        .admin-target-lock-select {
            width: 100%; padding: 4px 6px; font-size: 0.72rem;
            background: #34495e; color: #ecf0f1; border: 1px solid #4a6278;
            border-radius: 4px; font-weight: 600; outline: none; cursor: pointer;
        }
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

    function updateTypeDropdownStyle() {
        var val = typeSelect.value;
        typeSelect.className = 'rd-select ' + (val === 'Hunt' ? 'type-hunt' : (val === 'Hint' ? 'type-hint' : 'type-anders'));

        if (val === 'Anders') {
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

    document.getElementById('rd-btn-cancel').addEventListener('click', closeRdModal);
    document.getElementById('rd-btn-save').addEventListener('click', saveRdModalData);

    var mapWrapper = document.getElementById('map-wrapper');
    if (mapWrapper && !document.getElementById('admin-settings-panel')) {
        var settingsPanel = document.createElement('div');
        settingsPanel.id = 'admin-settings-panel';
        settingsPanel.innerHTML = `
            <div id="admin-settings-header">
                <span>⚙️ Beheer Instellingen</span>
                <button type="button" id="admin-settings-min-btn" title="Minimaliseren">-</button>
            </div>
            <div id="admin-settings-body">
                <div class="admin-setting-row">
                    <div class="admin-setting-label-wrap">
                        <span id="admin-max-hours-status-dot" class="admin-status-dot status-dot-green" title="Groei actief"></span>
                        <label id="admin-max-hours-label" for="admin-max-hours-input">Max. groeitijd cirkel (<b>X</b> uur):</label>
                    </div>
                    <input type="number" id="admin-max-hours-input" min="0.5" max="48" step="0.5" value="3">
                </div>
                <div id="admin-max-hours-subtext" class="admin-setting-subtext">
                    Cirkel stopt met groeien als laatste punt ouder is dan X uur. Snelheid negeert segmenten &gt; 7 km/u.
                </div>

                <hr class="admin-divider">

                <div class="admin-setting-row">
                    <div class="admin-setting-label-wrap">
                        <span id="admin-alt-route-status-dot" class="admin-status-dot status-dot-green" title="Alternatieve route actief"></span>
                        <label for="admin-alt-route-toggle" style="color:#bdc3c7;">🛤️ Toon alternatieve parallelroute (mijd N-wegen):</label>
                    </div>
                    <input type="checkbox" id="admin-alt-route-toggle" checked>
                </div>
                <div class="admin-setting-subtext">
                    Berekent een 2e doelgerichte route over de hele keten die N-wegen en dubbele wegen mijdt.
                </div>

                <hr class="admin-divider">

                <div class="admin-setting-row">
                    <div class="admin-setting-label-wrap">
                        <span id="admin-route-speed-status-dot" class="admin-status-dot status-dot-red" title="Loopsnelheid o.b.v. hemelsbreed"></span>
                        <label for="admin-route-speed-toggle" style="color:#bdc3c7;">🥾 Loopsnelheid o.b.v. wandelroute (i.p.v. hemelsbreed):</label>
                    </div>
                    <input type="checkbox" id="admin-route-speed-toggle">
                </div>
                <div class="admin-setting-subtext">
                    Gebruikt de snelste wandelafstand over wegen/paden tussen RD-punten voor de 50/50 snelheidsberekening.
                </div>

                <div id="admin-area-growth-list"></div>
            </div>
        `;
        mapWrapper.appendChild(settingsPanel);

        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(settingsPanel);
            L.DomEvent.disableScrollPropagation(settingsPanel);
        }

        var minBtn = document.getElementById('admin-settings-min-btn');
        var settingsBody = document.getElementById('admin-settings-body');
        minBtn.addEventListener('click', function() {
            if (settingsBody.style.display === 'none') {
                settingsBody.style.display = 'flex';
                minBtn.innerText = '-';
            } else {
                settingsBody.style.display = 'none';
                minBtn.innerText = '+';
            }
        });

        var maxHoursInput = document.getElementById('admin-max-hours-input');
        maxHoursInput.addEventListener('change', function() {
            var val = parseFloat(this.value);
            if (isNaN(val) || val <= 0) {
                val = 3;
                this.value = 3;
            }
            adminSettings.maxCircleGrowthHours = val;
            db.ref('adminSettings').update({
                maxCircleGrowthHours: val,
                updatedAt: Date.now()
            }).then(function() {
                window.calculateAndPublishMapState(true);
            });
        });

        var altRouteToggle = document.getElementById('admin-alt-route-toggle');
        altRouteToggle.addEventListener('change', function() {
            var enabled = !!this.checked;
            adminSettings.showAltQuietRoute = enabled;
            updateAdminSettingsPanelStatus();
            db.ref('adminSettings').update({
                showAltQuietRoute: enabled,
                updatedAt: Date.now()
            }).then(function() {
                window.calculateAndPublishMapState(true);
            });
        });

        var routeSpeedToggle = document.getElementById('admin-route-speed-toggle');
        routeSpeedToggle.addEventListener('change', function() {
            var enabled = !!this.checked;
            adminSettings.useRouteSpeedCalculation = enabled;
            updateAdminSettingsPanelStatus();
            db.ref('adminSettings').update({
                useRouteSpeedCalculation: enabled,
                updatedAt: Date.now()
            }).then(function() {
                window.calculateAndPublishMapState(true);
            });
        });

        var sHeader = document.getElementById('admin-settings-header');
        var isDraggingPanel = false, dragStartX = 0, dragStartY = 0;

        sHeader.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            isDraggingPanel = true;
            dragStartX = e.clientX - settingsPanel.offsetLeft;
            dragStartY = e.clientY - settingsPanel.offsetTop;
            document.addEventListener('mousemove', onPanelMouseMove);
            document.addEventListener('mouseup', onPanelMouseUp);
        });

        sHeader.addEventListener('touchstart', function(e) {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            isDraggingPanel = true;
            var touch = e.touches[0];
            dragStartX = touch.clientX - settingsPanel.offsetLeft;
            dragStartY = touch.clientY - settingsPanel.offsetTop;
            document.addEventListener('touchmove', onPanelTouchMove, { passive: false });
            document.addEventListener('touchend', onPanelTouchEnd);
        });

        function moveSettingsPanel(clientX, clientY) {
            var maxX = Math.max(0, window.innerWidth - settingsPanel.offsetWidth);
            var maxY = Math.max(0, mapWrapper.clientHeight - settingsPanel.offsetHeight);
            var newX = Math.max(0, Math.min(clientX - dragStartX, maxX));
            var newY = Math.max(0, Math.min(clientY - dragStartY, maxY));
            settingsPanel.style.left = newX + 'px';
            settingsPanel.style.top = newY + 'px';
            settingsPanel.style.right = 'auto';
        }

        function onPanelMouseMove(e) {
            if (isDraggingPanel) moveSettingsPanel(e.clientX, e.clientY);
        }
        function onPanelTouchMove(e) {
            if (isDraggingPanel) {
                e.preventDefault();
                moveSettingsPanel(e.touches[0].clientX, e.touches[0].clientY);
            }
        }
        function onPanelMouseUp() {
            isDraggingPanel = false;
            document.removeEventListener('mousemove', onPanelMouseMove);
            document.removeEventListener('mouseup', onPanelMouseUp);
        }
        function onPanelTouchEnd() {
            isDraggingPanel = false;
            document.removeEventListener('touchmove', onPanelTouchMove);
            document.removeEventListener('touchend', onPanelTouchEnd);
        }
    }
}

function openRdModal(mode, existingKey, existingData) {
    injectAdminUI();
    currentEditingRdKey = (mode === 'edit') ? existingKey : null;

    var titleEl = document.getElementById('rd-modal-title');
    var typeSelect = document.getElementById('rd-type-select');
    var locInput = document.getElementById('rd-loc-input');
    var areaSelect = document.getElementById('rd-area-select');
    var dtInput = document.getElementById('rd-datetime-input');
    var errBox = document.getElementById('rd-modal-error');
    errBox.style.display = 'none';

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

    var chosenType = typeSelect.value;
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
        pointTimestamp: chosenType === "Anders" ? null : pointTimestampMs
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
    // Sla bij het afvinken als 'bezocht' de huidige timestamp op zodat de route-voorspeller weet wanneer ze er waren!
    updates[safeKey] = !current ? Date.now() : null;

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
        walkingRouteCache = {};
        segmentDistanceCache = {};
        areaCappedStatus = {};
        updateAdminSettingsPanelStatus();
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

/* --- 6. INITIALISATIE VAN DE ADMIN ENGINE --- */
window.initAdminEngine = function() {
    initMasterElection();

    proj4.defs("EPSG:28992", "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.387638888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.524,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs");
    proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

    injectAdminUI();

    var drawControl = new L.Control.Draw({
        edit: { featureGroup: drawnItems, remove: true },
        draw: {
            polygon: false, rectangle: false, circle: false, circlemarker: false, marker: true,
            polyline: { shapeOptions: { color: '#000000', weight: 4, className: 'route-line' } }
        }
    });
    map.addControl(drawControl);

    renderFixedHouses();

    db.ref('adminSettings').on('value', function(snapshot) {
        var val = snapshot.val() || {};
        if (val.maxCircleGrowthHours !== undefined) {
            var parsedHours = parseFloat(val.maxCircleGrowthHours);
            if (!isNaN(parsedHours) && parsedHours > 0) {
                adminSettings.maxCircleGrowthHours = parsedHours;
                var inputEl = document.getElementById('admin-max-hours-input');
                if (inputEl && document.activeElement !== inputEl) {
                    inputEl.value = parsedHours;
                }
            }
        }
        if (val.showAltQuietRoute !== undefined) {
            adminSettings.showAltQuietRoute = !!val.showAltQuietRoute;
        }
        if (val.useRouteSpeedCalculation !== undefined) {
            adminSettings.useRouteSpeedCalculation = !!val.useRouteSpeedCalculation;
        }
        adminSettings.lockedTargets = val.lockedTargets || {};

        updateAdminSettingsPanelStatus();
        window.calculateAndPublishMapState(false);
    });

    // Zorg dat ook Standby-Admins de statusballetjes, tekstkleuren en target-locks synchroon zien
    db.ref('computedMapState').on('value', function(snapshot) {
        var state = snapshot.val();
        var syncedStatus = {};
        if (state && state.areas) {
            Object.keys(state.areas).forEach(function(a) {
                var gf = state.areas[a].geofence;
                var pts = state.areas[a].points || [];
                var lastPt = pts.length > 0 ? pts[pts.length - 1] : null;
                if (gf) {
                    var isCap = !!gf.isCappedByAge;
                    var distStr = gf.radiusMeters >= 1000
                        ? (gf.radiusMeters / 1000).toFixed(1) + ' km'
                        : gf.radiusMeters + ' m';
                    syncedStatus[a] = {
                        isCapped: isCap,
                        statusLabel: isCap ? `Max (${adminSettings.maxCircleGrowthHours}u) bereikt` : `Groeit (${distStr})`,
                        autoTargetName: (lastPt && lastPt.autoTarget) ? lastPt.autoTarget : "Slim"
                    };
                }
            });
        }
        areaCappedStatus = syncedStatus;
        updateAdminSettingsPanelStatus();
    });

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
};