/* ==========================================================================
   4C. ADMIN-ENGINE.JS - MASTER LOCK, CENTRALE BEREKENING & INITIALISATIE
   (Wordt uitsluitend ingeladen voor de Admin)
   ========================================================================== */

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

function claimMasterLockNow() {
    if (!isAdmin) return;
    var now = Date.now();
    var lockRef = db.ref('adminMasterLock');
    lockRef.set({
        adminId: adminSessionId,
        lastHeartbeat: now
    });
    lockRef.onDisconnect().remove();
    isMasterAdmin = true;
    var badge = document.getElementById('user-badge');
    if (badge) badge.innerText = "Beheerder (⚡ Master Engine)";
}

function evaluateMasterRole() {
    if (!isAdmin) return;
    var now = Date.now();
    var badge = document.getElementById('user-badge');

    if (!currentMasterData || currentMasterData.adminId === adminSessionId || (now - (currentMasterData.lastHeartbeat || 0)) > 35000) {
        claimMasterLockNow();
    } else {
        isMasterAdmin = false;
        if (badge) badge.innerText = "Beheerder (Standby Sync)";
    }
}

/* --- 1. VOSSEN STATUS METRICS VOOR ALLE GEBRUIKERS --- */
function formatDurationShort(ms) {
    if (!ms || ms < 0) return "0m";
    var totalSec = Math.floor(ms / 1000);
    if (totalSec >= 12 * 3600) {
        return "12u 00m (max 12u)";
    }
    var hours = Math.floor(totalSec / 3600);
    var mins = Math.floor((totalSec % 3600) / 60);
    if (hours > 0) {
        return `${hours}u ${mins}m`;
    }
    return `${mins}m`;
}

async function computeFoxStatusMetricsForAllUsers(computedAreas, nowMs) {
    var metricsByArea = {};
    var usersObj = (typeof cachedUsersData === 'object' && cachedUsersData) ? cachedUsersData : {};

    var onlineUserIds = Object.keys(usersObj).filter(function(uid) {
        var u = usersObj[uid];
        if (!u || !u.lat || !u.lng) return false;
        if (u.hiddenByAdmin && (!u.lastSeen || u.lastSeen <= (u.hiddenAt || 0))) return false;
        return (nowMs - (u.lastSeen || 0)) <= (3 * 60 * 1000);
    });

    var allValidUserIds = Object.keys(usersObj).filter(function(uid) {
        var u = usersObj[uid];
        return u && typeof u.lat === 'number' && typeof u.lng === 'number';
    });

    for (var i = 0; i < targetAreas.length; i++) {
        var areaName = targetAreas[i];
        var stObj = currentFoxStatuses[areaName] || {};
        var colorKey = stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";
        var cfg = foxStatusConfig[colorKey] || foxStatusConfig["grijs"];

        var statusUpdatedAt = stObj.updatedAt || null;
        if (!statusUpdatedAt && stObj.timeFormatted && stObj.timeFormatted.includes(':')) {
            var tParts = stObj.timeFormatted.split(':');
            var dTemp = new Date(nowMs);
            dTemp.setHours(parseInt(tParts[0], 10) || 0, parseInt(tParts[1], 10) || 0, 0, 0);
            if (dTemp.getTime() > nowMs) dTemp.setDate(dTemp.getDate() - 1);
            statusUpdatedAt = dTemp.getTime();
        }

        var statusDurationText = statusUpdatedAt ? formatDurationShort(nowMs - statusUpdatedAt) : "Onbekend";

        var targetCoord = null;
        var targetLocationLabel = "Nog geen locatie bekend";

        var areaData = computedAreas[areaName];
        if (areaData && areaData.geofence) {
            if (areaData.geofence.liveExpectedFoxPoint && Array.isArray(areaData.geofence.liveExpectedFoxPoint.coord)) {
                targetCoord = areaData.geofence.liveExpectedFoxPoint.coord;
                targetLocationLabel = "Verwachte live looppositie";
            } else if (Array.isArray(areaData.geofence.center) && areaData.geofence.center.length === 2) {
                targetCoord = areaData.geofence.center;
                targetLocationLabel = "Laatste punt in lijn";
            }
        }

        if (!targetCoord && typeof getFallbackLatestVisitedHouseForArea === 'function') {
            var fbClub = getFallbackLatestVisitedHouseForArea(areaName);
            if (fbClub && Array.isArray(fbClub.latlng)) {
                targetCoord = fbClub.latlng;
                targetLocationLabel = "Laatst bezochte club (" + fbClub.houseName + ")";
            }
        }

        var userRoutes = {};
        var closestOnlineHunter = null;

        if (targetCoord) {
            for (var uIdx = 0; uIdx < allValidUserIds.length; uIdx++) {
                var uid = allValidUserIds[uIdx];
                var uData = usersObj[uid];
                var roadMetrics = await getDrivingDistanceAndTime(uData.lat, uData.lng, targetCoord[0], targetCoord[1]);

                userRoutes[uid] = {
                    name: uData.name || "Hunter",
                    distKm: roadMetrics.distKm,
                    durationMin: roadMetrics.durationMin,
                    isRoad: roadMetrics.isRoad
                };
            }

            onlineUserIds.forEach(function(onlineUid) {
                var rInfo = userRoutes[onlineUid];
                if (!rInfo) return;
                if (!closestOnlineHunter || rInfo.distKm < closestOnlineHunter.distKm) {
                    closestOnlineHunter = {
                        userId: onlineUid,
                        name: rInfo.name,
                        distKm: rInfo.distKm,
                        durationMin: rInfo.durationMin
                    };
                }
            });
        }

        metricsByArea[areaName] = {
            area: areaName,
            statusKey: colorKey,
            statusLabel: cfg.label,
            statusUpdatedAt: statusUpdatedAt || null,
            statusTimeFormatted: stObj.timeFormatted || "",
            statusDurationText: statusDurationText,
            estimatedCoord: targetCoord || null,
            locationTypeLabel: targetLocationLabel,
            closestOnlineUser: closestOnlineHunter,
            userRoutes: userRoutes
        };
    }

    return metricsByArea;
}

/* --- 2. CENTRALE BEREKENING & PUBLICATIE NAAR FIREBASE --- */
var isCalculatingMapState = false;
var pendingCalculationRequest = false;
var pendingForceManual = false;

window.calculateAndPublishMapState = async function(forceManual = false) {
    if (!isAdmin) return;

    if (forceManual) {
        claimMasterLockNow();
    }

    if (!isMasterAdmin && !forceManual) {
        updateAdminSettingsPanelStatus();
        return;
    }

    if (isCalculatingMapState) {
        pendingCalculationRequest = true;
        if (forceManual) pendingForceManual = true;
        return;
    }

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
            var lastRdPtMs = getPointTimestampMs(lastPoint);

            var speedResult = await calculateAreaWalkingSpeed(points);
            var calculatedSpeedKmh = speedResult.speedKmh;
            var speedText = speedResult.speedText;

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

            if (unvisitedHouses.length === 0 && areaHouses.length > 0) {
                unvisitedHouses = areaHouses.slice();
            }

            var historyChainObj = buildHistoricalChainWithVisitedHouses(points, visitedHouses);
            var historicalAnchoredCoords = historyChainObj.coords;
            var lastChainEvent = historyChainObj.lastEvent;

            var effectiveLastCoord = (historicalAnchoredCoords && historicalAnchoredCoords.length > 0)
                ? historicalAnchoredCoords[historicalAnchoredCoords.length - 1]
                : lastPoint.latlng;

            var effectiveLastMs = (lastChainEvent && lastChainEvent.ts && lastChainEvent.ts > 1000)
                ? lastChainEvent.ts
                : lastRdPtMs;

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

            var visitedContext = analyzeVisitedHousesContext(
                effectiveLastCoord,
                visitedHouses,
                lineMovementBearingDeg
            );

            var isFuture = (effectiveLastMs > nowMs);
            var rawSecondsPassed = isFuture ? 0 : Math.floor((nowMs - effectiveLastMs) / 1000);
            var isCappedByAge = (!isFuture && rawSecondsPassed >= maxGrowthSeconds);
            var effectiveSecondsPassed = isCappedByAge ? maxGrowthSeconds : rawSecondsPassed;

            var effectiveSpeedKmh = calculatedSpeedKmh !== null ? calculatedSpeedKmh : 6.5;
            var currentRadiusMeters = 1;
            if (!isFuture) {
                var metersPerSecond = (effectiveSpeedKmh * 1000) / 3600;
                currentRadiusMeters = Math.max(1, Math.round(1 + (effectiveSecondsPassed * metersPerSecond)));
            }

            var lockedTargetName = (adminSettings.lockedTargets && adminSettings.lockedTargets[area])
                ? adminSettings.lockedTargets[area]
                : null;

            if (lockedTargetName && !unvisitedHouses.some(function(h) { return h.name === lockedTargetName; })) {
                lockedTargetName = null;
            }

            var targetHousesChain = selectSemiLogicalTargetHouses(
                effectiveLastCoord,
                lineMovementBearingDeg,
                unvisitedHouses,
                visitedContext,
                lockedTargetName,
                currentRadiusMeters + 2500
            );
            var primaryTargetHouse = targetHousesChain.length > 0 ? targetHousesChain[0] : null;

            var bearingDeg = null;
            if (historicalAnchoredCoords.length >= 2 || visitedContext.originBearingDeg !== null || primaryTargetHouse) {
                var sumSin = 0, sumCos = 0, totalWeight = 0;

                if (historicalAnchoredCoords.length >= 2) {
                    var pPrev = historicalAnchoredCoords[historicalAnchoredCoords.length - 2];
                    var pCurr = historicalAnchoredCoords[historicalAnchoredCoords.length - 1];
                    var bLast = getBearing(pPrev[0], pPrev[1], pCurr[0], pCurr[1]) * Math.PI / 180;
                    sumSin += 0.40 * Math.sin(bLast); sumCos += 0.40 * Math.cos(bLast); totalWeight += 0.40;
                }

                if (historicalAnchoredCoords.length >= 3) {
                    var pPrev2 = historicalAnchoredCoords[historicalAnchoredCoords.length - 3];
                    var pPrev1 = historicalAnchoredCoords[historicalAnchoredCoords.length - 2];
                    var bPrev = getBearing(pPrev2[0], pPrev2[1], pPrev1[0], pPrev1[1]) * Math.PI / 180;
                    sumSin += 0.10 * Math.sin(bPrev); sumCos += 0.10 * Math.cos(bPrev); totalWeight += 0.10;
                }

                if (visitedContext.originBearingDeg !== null) {
                    var bVisitedOrigin = visitedContext.originBearingDeg * Math.PI / 180;
                    sumSin += 0.20 * Math.sin(bVisitedOrigin); sumCos += 0.20 * Math.cos(bVisitedOrigin); totalWeight += 0.20;
                }

                if (primaryTargetHouse) {
                    var bHouse = getBearing(effectiveLastCoord[0], effectiveLastCoord[1], primaryTargetHouse.lat, primaryTargetHouse.lng) * Math.PI / 180;
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
                ? `${area}: 1 m (in toekomst)`
                : (isCappedByAge
                    ? `${area}: ${distFormatted} (max ${maxGrowthHours}u bereikt)`
                    : `${area}: ${distFormatted}`);

            newAreaCappedStatus[area] = {
                isCapped: isCappedByAge,
                statusLabel: isCappedByAge ? `Max (${maxGrowthHours}u) bereikt` : `Groeit (${distFormatted})`,
                autoTargetName: primaryTargetHouse ? primaryTargetHouse.name : "Geen"
            };

            var arrows = [];
            if (bearingDeg !== null && !isFuture) {
                [-60, 60].forEach(function(offsetAngle) {
                    var arrowAngle = Math.round((bearingDeg + offsetAngle + 360) % 360);
                    var arrowEndCoord = getDestinationLatLng(effectiveLastCoord[0], effectiveLastCoord[1], currentRadiusMeters, arrowAngle);
                    arrows.push({
                        angle: arrowAngle,
                        endCoord: arrowEndCoord
                    });
                });
            }

            var estimatedWalkRoute = [];
            var alternativeWalkRoute = [];
            var estimatedTargetHouseName = "";
            var visitedOriginHouseName = (lastChainEvent && lastChainEvent.type === 'house')
                ? lastChainEvent.name
                : (visitedContext.nearestVisited ? visitedContext.nearestVisited.name : "");
            var circleIntersectionPoint = null;
            var liveExpectedFoxPoint = null;
            var altLiveExpectedFoxPoint = null;

            if (targetHousesChain.length > 0) {
                var waypoints = [effectiveLastCoord];

                targetHousesChain.forEach(function(h) {
                    var prevW = waypoints[waypoints.length - 1];
                    if (getDistanceKm(prevW[0], prevW[1], h.lat, h.lng) > 0.01) {
                        waypoints.push([h.lat, h.lng]);
                    }
                });

                var lockPrefix = lockedTargetName ? "🔒 " : "";
                var chainLabelParts = [];
                if (lastChainEvent && lastChainEvent.type === 'house') {
                    chainLabelParts.push("✔️ " + lastChainEvent.name);
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
                        effectiveLastCoord,
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
                    center: effectiveLastCoord,
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

        var foxStatusMetrics = await computeFoxStatusMetricsForAllUsers(computedAreas, nowMs);

        await db.ref('computedMapState').set({
            updatedAt: Date.now(),
            masterId: adminSessionId,
            areas: computedAreas,
            otherPoints: processedOtherPoints,
            foxStatusMetrics: foxStatusMetrics
        });
    } finally {
        isCalculatingMapState = false;
        if (pendingCalculationRequest) {
            var nextForce = pendingForceManual;
            pendingCalculationRequest = false;
            pendingForceManual = false;
            setTimeout(function() {
                window.calculateAndPublishMapState(nextForce);
            }, 150);
        }
    }
};

/* --- 3. INITIALISATIE VAN DE ADMIN ENGINE --- */
window.initAdminEngine = function() {
    initMasterElection();

    proj4.defs("EPSG:28992", "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.387638888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.524,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs");
    proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

    injectAdminUI();
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
        if (val.counterHuntAlertMinutes !== undefined) {
            var parsedMins = parseFloat(val.counterHuntAlertMinutes);
            if (!isNaN(parsedMins) && parsedMins > 0) {
                adminSettings.counterHuntAlertMinutes = parsedMins;
                var chInputEl = document.getElementById('admin-ch-timer-input');
                if (chInputEl && document.activeElement !== chInputEl) {
                    chInputEl.value = parsedMins;
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
        window.syncAdminFoxFilterCheckboxes();
        window.calculateAndPublishMapState(false);
    });

    db.ref('foxStatuses').on('value', function() {
        if (typeof window.syncAdminFoxFilterCheckboxes === 'function') {
            window.syncAdminFoxFilterCheckboxes();
        }
        window.calculateAndPublishMapState(false);
    });

    db.ref('liveUsers').on('value', function() {
        window.calculateAndPublishMapState(false);
    });

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

    db.ref('jotihuntSync').remove().catch(function() {});

    setInterval(function() {
        window.calculateAndPublishMapState(false);
    }, 10000);
};