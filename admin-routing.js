/* ==========================================================================
   4A. ADMIN-ROUTING.JS - WISKUNDE, OSRM ROUTERING, GEOCODING & SNELHEID
   (Wordt uitsluitend ingeladen voor de Admin)
   ========================================================================== */

var rawRdPointsByArea = { "Alpha": [], "Bravo": [], "Delta": [], "Foxtrot": [], "Golf": [], "Hotel": [], "Oscar": [] };
var rawOtherPoints = [];
var currentEditingRdKey = null;

var walkingRouteCache = {};
var segmentDistanceCache = {};
var drivingRouteMetricsCache = {};
var areaCappedStatus = {};

var adminSettings = {
    maxCircleGrowthHours: 3,
    counterHuntAlertMinutes: 5,
    maxWalkingSpeedKmh: 7.0,
    defaultSpeedKmh: 6.5,
    showAltQuietRoute: true,
    useRouteSpeedCalculation: false,
    lockedTargets: {}
};

function sleepMs(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/* --- 1. WISKUNDE, RICHTINGSVECTOREN & KETEN-LOGICA --- */
function getBearing(lat1, lon1, lat2, lon2) {
    var y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
    var x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
    var brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
}

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

function getHouseVisitedTimestamp(houseName) {
    var safeKey = houseName.replace(/[.#$[\]]/g, '_');
    var val = houseVisitedStatus[safeKey];
    if (!val) return null;
    if (typeof val === 'number' && val > 1000) return val;
    if (typeof val === 'object' && val.visitedAt) return Number(val.visitedAt);
    return 1;
}

function buildHistoricalChainWithVisitedHouses(sortedPoints, visitedHouses) {
    if ((!sortedPoints || sortedPoints.length === 0) && (!visitedHouses || visitedHouses.length === 0)) {
        return { coords: [], lastEvent: null };
    }

    var timelineEvents = [];
    var usedHouses = {};

    if (sortedPoints && sortedPoints.length > 0) {
        sortedPoints.forEach(function(pt, idx) {
            timelineEvents.push({
                type: 'rd',
                point: pt,
                name: pt.fullName || pt.baseName || "RD",
                latlng: [pt.latlng[0], pt.latlng[1]],
                ts: getPointTimestampMs(pt),
                orderIdx: idx
            });
        });
    }

    var untimedHouses = [];
    if (visitedHouses && visitedHouses.length > 0) {
        visitedHouses.forEach(function(h, idx) {
            var ts = getHouseVisitedTimestamp(h.name);
            if (ts && ts > 1000) {
                usedHouses[h.name] = true;
                timelineEvents.push({
                    type: 'house',
                    house: h,
                    name: h.name,
                    latlng: [h.lat, h.lng],
                    ts: ts,
                    orderIdx: 1000 + idx
                });
            } else {
                untimedHouses.push(h);
            }
        });
    }

    timelineEvents.sort(function(a, b) {
        if (a.ts !== b.ts) return a.ts - b.ts;
        if (a.type !== b.type) return a.type === 'house' ? 1 : -1;
        return a.orderIdx - b.orderIdx;
    });

    if (timelineEvents.length === 0) {
        return { coords: [], lastEvent: null };
    }

    var orderedEvents = [timelineEvents[0]];

    for (var i = 0; i < timelineEvents.length - 1; i++) {
        var evA = timelineEvents[i];
        var evB = timelineEvents[i + 1];
        var segDistKm = getDistanceKm(evA.latlng[0], evA.latlng[1], evB.latlng[0], evB.latlng[1]);

        if (untimedHouses.length > 0 && segDistKm > 0.05) {
            var candidates = [];
            untimedHouses.forEach(function(h) {
                if (usedHouses[h.name]) return;
                var dToSeg = getPointToSegmentDistanceKm(h.lat, h.lng, evA.latlng[0], evA.latlng[1], evB.latlng[0], evB.latlng[1]);
                var dA = getDistanceKm(evA.latlng[0], evA.latlng[1], h.lat, h.lng);
                var dB = getDistanceKm(h.lat, h.lng, evB.latlng[0], evB.latlng[1]);
                var detourKm = (dA + dB) - segDistKm;

                if (dToSeg <= 0.45 && detourKm <= 0.85) {
                    candidates.push({ house: h, dA: dA });
                }
            });

            candidates.sort(function(a, b) { return a.dA - b.dA; });
            candidates.forEach(function(c) {
                usedHouses[c.house.name] = true;
                orderedEvents.push({
                    type: 'house',
                    house: c.house,
                    name: c.house.name,
                    latlng: [c.house.lat, c.house.lng],
                    ts: Math.round((evA.ts + evB.ts) / 2)
                });
            });
        }

        orderedEvents.push(evB);
    }

    if (untimedHouses.length > 0) {
        var currentTail = orderedEvents[orderedEvents.length - 1];
        var prevTail = orderedEvents.length >= 2 ? orderedEvents[orderedEvents.length - 2] : null;
        var tailBearing = prevTail ? getBearing(prevTail.latlng[0], prevTail.latlng[1], currentTail.latlng[0], currentTail.latlng[1]) : null;

        var nearbyUntimed = [];
        untimedHouses.forEach(function(h) {
            if (usedHouses[h.name]) return;
            var dTailKm = getDistanceKm(currentTail.latlng[0], currentTail.latlng[1], h.lat, h.lng);
            if (dTailKm <= 0.55) {
                if (tailBearing !== null && dTailKm > 0.25) {
                    var bToH = getBearing(currentTail.latlng[0], currentTail.latlng[1], h.lat, h.lng);
                    if (getAngleDifferenceDeg(tailBearing, bToH) > 120) return;
                }
                nearbyUntimed.push({ house: h, distKm: dTailKm });
            }
        });

        nearbyUntimed.sort(function(a, b) { return a.distKm - b.distKm; });
        nearbyUntimed.forEach(function(item) {
            usedHouses[item.house.name] = true;
            orderedEvents.push({
                type: 'house',
                house: item.house,
                name: item.house.name,
                latlng: [item.house.lat, item.house.lng],
                ts: currentTail.ts
            });
        });
    }

    var resultCoords = [orderedEvents[0].latlng];
    for (var k = 1; k < orderedEvents.length; k++) {
        var prevC = resultCoords[resultCoords.length - 1];
        var currC = orderedEvents[k].latlng;
        if (getDistanceKm(prevC[0], prevC[1], currC[0], currC[1]) > 0.003) {
            resultCoords.push(currC);
        }
    }

    return {
        coords: resultCoords,
        lastEvent: orderedEvents[orderedEvents.length - 1]
    };
}

function analyzeVisitedHousesContext(effectiveLastLatLng, visitedHouses, lineMovementBearingDeg) {
    if (!visitedHouses || visitedHouses.length === 0) {
        return {
            originBearingDeg: lineMovementBearingDeg,
            nearestVisited: null,
            visitedCentroid: null
        };
    }

    var sortedByDistance = visitedHouses.slice().sort(function(a, b) {
        var dA = getDistanceKm(effectiveLastLatLng[0], effectiveLastLatLng[1], a.lat, a.lng);
        var dB = getDistanceKm(effectiveLastLatLng[0], effectiveLastLatLng[1], b.lat, b.lng);
        return dA - dB;
    });

    var nearestVisited = sortedByDistance[0];
    var nearestDistKm = getDistanceKm(effectiveLastLatLng[0], effectiveLastLatLng[1], nearestVisited.lat, nearestVisited.lng);

    var sumLat = 0, sumLng = 0, totalW = 0;
    visitedHouses.forEach(function(h) {
        var d = Math.max(0.2, getDistanceKm(effectiveLastLatLng[0], effectiveLastLatLng[1], h.lat, h.lng));
        var w = 1 / d;
        sumLat += h.lat * w;
        sumLng += h.lng * w;
        totalW += w;
    });
    var visitedCentroid = totalW > 0 ? [sumLat / totalW, sumLng / totalW] : [nearestVisited.lat, nearestVisited.lng];

    var originBearingDeg = null;
    if (nearestDistKm > 0.05) {
        originBearingDeg = getBearing(nearestVisited.lat, nearestVisited.lng, effectiveLastLatLng[0], effectiveLastLatLng[1]);
    } else if (lineMovementBearingDeg !== null) {
        originBearingDeg = lineMovementBearingDeg;
    }

    return {
        originBearingDeg: originBearingDeg,
        nearestVisited: nearestVisited,
        visitedCentroid: visitedCentroid
    };
}

function selectSemiLogicalTargetHouses(effectiveStartLatLng, movementBearingDeg, unvisitedHouses, visitedContext, lockedHouseName, minRequiredChainMeters) {
    if (!unvisitedHouses || unvisitedHouses.length === 0) return [];

    var requiredDistKm = Math.max(3.5, ((minRequiredChainMeters || 3000) / 1000) * 1.25);

    var chain = [];
    var remaining = unvisitedHouses.slice();
    var currentPos = [effectiveStartLatLng[0], effectiveStartLatLng[1]];
    var currentBearing = movementBearingDeg;
    var accumulatedDistKm = 0;

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

    while (remaining.length > 0 && (chain.length < 2 || accumulatedDistKm < requiredDistKm) && chain.length < 4) {
        var scoredNext = remaining.map(function(h) {
            var distKm = getDistanceKm(currentPos[0], currentPos[1], h.lat, h.lng);
            var bearingToNext = getBearing(currentPos[0], currentPos[1], h.lat, h.lng);
            var angleDiff = currentBearing !== null ? getAngleDifferenceDeg(currentBearing, bearingToNext) : 0;
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

/* --- 2. OSRM WANDELROUTES & WEG-AFSTANDEN --- */
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

function getPolylineLengthMeters(coords) {
    if (!coords || coords.length < 2) return 0;
    var total = 0;
    for (var i = 0; i < coords.length - 1; i++) {
        total += getDistanceKm(coords[i][0], coords[i + 1][1] ? coords[i][1] : coords[i][1], coords[i + 1][0], coords[i + 1][1]) * 1000;
    }
    return total;
}

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

function getRouteSeparationMeters(routeA, routeB) {
    if (!routeA || !routeB || routeA.length < 2 || routeB.length < 2) return 0;
    var sampleFractions = [0.15, 0.30, 0.50, 0.70, 0.85];
    var maxMinDist = 0;
    sampleFractions.forEach(function(frac) {
        var idx = Math.floor(routeA.length * frac);
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

        var distFromStart = getDistanceKm(p1[0], p1[1], candidateCoords[0][0], candidateCoords[0][1]) * 1000;
        if (distFromStart < 35) continue;

        var isOverlapping = false;
        for (var j = 0; j < avoidHistoryCoords.length - 1; j++) {
            var h1 = avoidHistoryCoords[j];
            var h2 = avoidHistoryCoords[j + 1];
            var dKm = getPointToSegmentDistanceKm(midLat, midLng, h1[0], h1[1], h2[0], h2[1]);
            if (dKm <= 0.028) {
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

async function fetchOsrmFootRoutes(coordString, timeoutMs) {
    var endpoints = [
        `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coordString}?overview=full&geometries=geojson&alternatives=true&steps=true`,
        `https://router.project-osrm.org/route/v1/foot/${coordString}?overview=full&geometries=geojson&alternatives=true&steps=true`
    ];

    for (var attempt = 0; attempt < 2; attempt++) {
        for (var i = 0; i < endpoints.length; i++) {
            try {
                var controller = new AbortController();
                var tId = setTimeout(function() { controller.abort(); }, timeoutMs || 6500);
                var res = await fetch(endpoints[i], { signal: controller.signal });
                clearTimeout(tId);

                if (res.ok) {
                    var data = await res.json();
                    if (data && data.routes && data.routes.length > 0) {
                        return data.routes;
                    }
                } else if (res.status === 429) {
                    await sleepMs(350);
                }
            } catch (err) {}
        }
        if (attempt === 0) {
            await sleepMs(250);
        }
    }
    return null;
}

async function getDrivingDistanceAndTime(fromLat, fromLng, toLat, toLng) {
    var straightKm = getDistanceKm(fromLat, fromLng, toLat, toLng);
    if (straightKm < 0.05) {
        return { distKm: 0.1, durationMin: 1, isRoad: true };
    }

    var cacheKey = `${fromLat.toFixed(3)},${fromLng.toFixed(3)}_${toLat.toFixed(3)},${toLng.toFixed(3)}`;
    var now = Date.now();
    if (drivingRouteMetricsCache[cacheKey] && (now - drivingRouteMetricsCache[cacheKey].ts) < 90000) {
        return drivingRouteMetricsCache[cacheKey].data;
    }

    var coordStr = `${fromLng},${fromLat};${toLng},${toLat}`;
    var endpoints = [
        `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordStr}?overview=false`,
        `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=false`
    ];

    for (var i = 0; i < endpoints.length; i++) {
        try {
            var controller = new AbortController();
            var tId = setTimeout(function() { controller.abort(); }, 3200);
            var res = await fetch(endpoints[i], { signal: controller.signal });
            clearTimeout(tId);

            if (res.ok) {
                var data = await res.json();
                if (data && data.routes && data.routes.length > 0) {
                    var r = data.routes[0];
                    var roadKm = Math.max(0.1, Math.round((r.distance / 1000) * 10) / 10);
                    var roadMin = Math.max(1, Math.round(r.duration / 60));
                    var result = { distKm: roadKm, durationMin: roadMin, isRoad: true };
                    drivingRouteMetricsCache[cacheKey] = { ts: now, data: result };
                    return result;
                }
            }
        } catch (err) {}
    }

    var estRoadKm = Math.max(0.1, Math.round((straightKm * 1.28) * 10) / 10);
    var estMin = Math.max(1, Math.round((estRoadKm / 48) * 60));
    return { distKm: estRoadKm, durationMin: estMin, isRoad: false };
}

async function getBestSegmentRoute(startLatLng, endLatLng, avoidHistoryCoords, speedKmh, preferQuietParallel, primaryReferenceRoute) {
    var effSpeed = Math.max(2.0, Number(speedKmh) || 6.5);
    var maxDetourMetersFor15Min = (effSpeed * (15 / 60)) * 1000;
    var allowedExtraMeters = preferQuietParallel ? Math.max(2500, maxDetourMetersFor15Min * 1.75) : maxDetourMetersFor15Min;

    var directCoordStr = `${startLatLng[1]},${startLatLng[0]};${endLatLng[1]},${endLatLng[0]}`;
    var rawRoutes = await fetchOsrmFootRoutes(directCoordStr, 6500);

    var candidates = [];

    if (rawRoutes && rawRoutes.length > 0) {
        rawRoutes.forEach(function(r) {
            if (!r.geometry || !r.geometry.coordinates || r.geometry.coordinates.length < 2) return;
            var simp = simplifyRouteCoords(r.geometry.coordinates, 110, false);
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
    }

    if (candidates.length === 0) {
        var fallbackPinned = enforceExactEndpointPinning([startLatLng, endLatLng], startLatLng, endLatLng);
        return {
            coords: fallbackPinned,
            isFallback: true
        };
    }

    var shortestDirectMeters = candidates[0].distMeters;
    var bestDirectOverlap = candidates[0].overlapMeters;

    var alreadyHasSeparatedAlt = false;
    if (preferQuietParallel && primaryReferenceRoute && primaryReferenceRoute.length >= 2) {
        alreadyHasSeparatedAlt = candidates.some(function(c) {
            return getRouteSeparationMeters(c.coords, primaryReferenceRoute) >= 45 &&
                   (c.distMeters - shortestDirectMeters) <= allowedExtraMeters;
        });
    }

    var needLoopAlternatives = (bestDirectOverlap > 45) || (preferQuietParallel && !alreadyHasSeparatedAlt);

    if (needLoopAlternatives) {
        var directDistMeters = getDistanceKm(startLatLng[0], startLatLng[1], endLatLng[0], endLatLng[1]) * 1000;
        if (directDistMeters >= 80 && directDistMeters <= 25000) {
            var midLat = (startLatLng[0] + endLatLng[0]) / 2;
            var midLng = (startLatLng[1] + endLatLng[1]) / 2;
            var mainBearing = getBearing(startLatLng[0], startLatLng[1], endLatLng[0], endLatLng[1]);

            var offsetMeters = Math.min(800, Math.max(150, Math.round(directDistMeters * 0.22)));
            var sideBearings = [(mainBearing + 90) % 360, (mainBearing + 270) % 360];

            var pivotLat = (bestDirectOverlap > 45 && !preferQuietParallel)
                ? (startLatLng[0] * 0.65 + endLatLng[0] * 0.35)
                : midLat;
            var pivotLng = (bestDirectOverlap > 45 && !preferQuietParallel)
                ? (startLatLng[1] * 0.65 + endLatLng[1] * 0.35)
                : midLng;

            for (var s = 0; s < sideBearings.length; s++) {
                await sleepMs(80);
                var viaPt = getDestinationLatLng(pivotLat, pivotLng, offsetMeters, sideBearings[s]);
                var viaCoordStr = `${startLatLng[1]},${startLatLng[0]};${viaPt[1]},${viaPt[0]};${endLatLng[1]},${endLatLng[0]}`;
                var viaRoutes = await fetchOsrmFootRoutes(viaCoordStr, 5000);
                if (viaRoutes && viaRoutes.length > 0) {
                    var rVia = viaRoutes[0];
                    if (rVia.geometry && rVia.geometry.coordinates && rVia.geometry.coordinates.length >= 2) {
                        var simpVia = simplifyRouteCoords(rVia.geometry.coordinates, 110, false);
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
    }

    var validCandidates = candidates.filter(function(c) {
        var extraMeters = c.distMeters - shortestDirectMeters;
        return extraMeters <= allowedExtraMeters;
    });

    if (validCandidates.length === 0) {
        validCandidates = candidates.slice();
    }

    if (preferQuietParallel && primaryReferenceRoute && primaryReferenceRoute.length >= 2) {
        var separatedCandidates = validCandidates.filter(function(c) {
            return getRouteSeparationMeters(c.coords, primaryReferenceRoute) >= 35;
        });

        var pool = separatedCandidates.length > 0 ? separatedCandidates : validCandidates;
        pool.sort(function(a, b) {
            var sepBonusA = getRouteSeparationMeters(a.coords, primaryReferenceRoute) >= 35 ? -250 : 0;
            var sepBonusB = getRouteSeparationMeters(b.coords, primaryReferenceRoute) >= 35 ? -250 : 0;
            var scoreA = a.distMeters + (a.overlapMeters * 4.5) + (a.nRoadMeters * 3.5) + sepBonusA;
            var scoreB = b.distMeters + (b.overlapMeters * 4.5) + (b.nRoadMeters * 3.5) + sepBonusB;
            return scoreA - scoreB;
        });
        return {
            coords: pool[0].coords,
            isFallback: false
        };
    }

    validCandidates.sort(function(a, b) {
        var scoreA = a.distMeters + (a.overlapMeters * 6.0);
        var scoreB = b.distMeters + (b.overlapMeters * 6.0);
        return scoreA - scoreB;
    });

    return {
        coords: validCandidates[0].coords,
        isFallback: false
    };
}

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
        var cached = walkingRouteCache[cacheKey];
        if (!wantAlternative || (cached.alternative && cached.alternative.length >= 2)) {
            return cached;
        }
    }

    var primaryFullCoords = [];
    var altFullCoords = [];
    var anyFallbackUsed = false;

    var primaryAvoidHistory = (initialHistoryCoords && initialHistoryCoords.length >= 2)
        ? initialHistoryCoords.slice()
        : [];

    var altAvoidHistory = (initialHistoryCoords && initialHistoryCoords.length >= 2)
        ? initialHistoryCoords.slice()
        : [];

    var stagePrimaryRoutes = [];

    for (var i = 0; i < waypointsLatLng.length - 1; i++) {
        var segStart = waypointsLatLng[i];
        var segEnd = waypointsLatLng[i + 1];

        if (i > 0) await sleepMs(75);

        var segPrimaryObj = await getBestSegmentRoute(
            segStart,
            segEnd,
            primaryAvoidHistory,
            speedKmh,
            false,
            null
        );

        if (segPrimaryObj.isFallback) {
            anyFallbackUsed = true;
        }

        var segPrimary = segPrimaryObj.coords;
        stagePrimaryRoutes.push(segPrimary);

        if (primaryFullCoords.length === 0) {
            primaryFullCoords = segPrimary.slice();
        } else {
            primaryFullCoords = primaryFullCoords.concat(segPrimary.slice(1));
        }

        primaryAvoidHistory = primaryAvoidHistory.concat(segPrimary);
    }

    if (wantAlternative) {
        for (var j = 0; j < waypointsLatLng.length - 1; j++) {
            var altStart = waypointsLatLng[j];
            var altEnd = waypointsLatLng[j + 1];
            var refPrimarySeg = stagePrimaryRoutes[j];

            await sleepMs(75);

            var segAltObj = await getBestSegmentRoute(
                altStart,
                altEnd,
                altAvoidHistory,
                speedKmh,
                true,
                refPrimarySeg
            );

            if (segAltObj.isFallback) {
                anyFallbackUsed = true;
            }

            var segAlt = segAltObj.coords;

            if (altFullCoords.length === 0) {
                altFullCoords = segAlt.slice();
            } else {
                altFullCoords = altFullCoords.concat(segAlt.slice(1));
            }

            altAvoidHistory = altAvoidHistory.concat(segAlt);
        }
    }

    var finalResult = {
        primary: simplifyRouteCoords(primaryFullCoords, 220, true),
        alternative: (wantAlternative && altFullCoords.length >= 2) ? simplifyRouteCoords(altFullCoords, 220, true) : []
    };

    if (!anyFallbackUsed && finalResult.primary.length > waypointsLatLng.length) {
        walkingRouteCache[cacheKey] = finalResult;
    }

    return finalResult;
}

async function getFastestWalkingDistanceKmBetweenPoints(lat1, lng1, lat2, lng2) {
    var straightKm = getDistanceKm(lat1, lng1, lat2, lng2);
    if (straightKm < 0.03 || straightKm > 25.0) {
        return straightKm;
    }

    var key = `${lat1.toFixed(5)},${lng1.toFixed(5)}_${lat2.toFixed(5)},${lng2.toFixed(5)}`;
    if (segmentDistanceCache[key] !== undefined) {
        return segmentDistanceCache[key];
    }

    var coordStr = `${lng1},${lat1};${lng2},${lat2}`;
    var routes = await fetchOsrmFootRoutes(coordStr, 4500);
    if (routes && routes.length > 0 && routes[0].distance > 0) {
        var walkKm = routes[0].distance / 1000;
        segmentDistanceCache[key] = walkKm;
        return walkKm;
    }

    return straightKm;
}

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

/* --- 3. RD-CONVERSIE, PDOK/OSM GEOCODING & TIJDSTIPPEN --- */
function parseTargetArea(input) {
    if (!input) return "";
    var cleanInput = input.trim().toLowerCase();
    return targetAreas.find(function(area) {
        return area.toLowerCase() === cleanInput;
    }) || "";
}

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

/* --- 4. SLIMME SNELHEIDSBEREKENING --- */
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