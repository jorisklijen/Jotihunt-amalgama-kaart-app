/* ==========================================================================
   4. ADMIN-ENGINE.JS - CENTRALE REKENMOTOR & BEHEER (ALLEEN VOOR ADMIN)
   Inclusief:
   - Multi-Admin Master Lock
   - RD (met/zonder komma), GPS & Adres-Geocoding (PDOK / OSM)
   - Gekleurde Dropdown (Hint / Hunt / Anders) waarbij 'Anders' geen gebied/tijd heeft
   - Slimme Loopsnelheid: Negeert verplaatsingen > 7 km/u, weegt laatste segment
     voor 50% en overige geldige segmenten voor 50% (Hunt -> fallback Hint -> 6.5 km/u)
   - Semi-logische Voorspellende Wandelroute langs onbezochte clubhuizen:
     Neemt nu OOK al bezochte clubhuizen mee als herkomst-vector / ankerpunt!
   - Handmatige Doel-Clubhuis Lock per deelgebied (via laatste RD-punt popup én Admin-menu)
   - Instelbare Alternatieve Route (mijdt N-wegen / drukke wegen en kiest parallelwegen)
   - Live Verwachte Vos-positie langs de wandelroute + Snijpunt met cirkelrand
   - Zwevend Admin-paneel met groene/rode statusballetjes en dynamische tekstkleur.
   ========================================================================== */

var rawRdPointsByArea = { "Alpha": [], "Bravo": [], "Delta": [], "Foxtrot": [], "Golf": [], "Hotel": [], "Oscar": [] };
var rawOtherPoints = []; // Voor punten met type "Anders" (zonder deelgebied en tijdstip)
var currentEditingRdKey = null;

/* Cache voor opgehaalde wandelroutes zodat we niet elke 30s onnodig API-calls doen */
var walkingRouteCache = {};

/* Houdt per deelgebied bij of de max groeitijd is bereikt voor de UI-statusballetjes */
var areaCappedStatus = {};

/* Instellingen voor snelheidsberekening, cirkelgroei, alternatieve routes & locked targets */
var adminSettings = {
    maxCircleGrowthHours: 3,
    maxWalkingSpeedKmh: 7.0,
    defaultSpeedKmh: 6.5,
    showAltQuietRoute: true,
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

/* Hulpfunctie: Geeft de timestamp terug waarop een clubhuis als bezocht is gemarkeerd (of 1 als alleen boolean 'true') */
function getHouseVisitedTimestamp(houseName) {
    var safeKey = houseName.replace(/[.#$[\]]/g, '_');
    var val = houseVisitedStatus[safeKey];
    if (!val) return null;
    if (typeof val === 'number' && val > 1000) return val;
    if (typeof val === 'object' && val.visitedAt) return Number(val.visitedAt);
    return 1; // Standaard boolean true
}

/* Analyseert de reeds BEZOCHTE clubgebouwen in het deelgebied om te bepalen:
   1. Vanuit welke sector/club de vossen zijn gekomen (zodat de route logisch vooruit loopt, weg van bezochte clubs)
   2. Of een bezocht clubhuis ná het laatste RD-punt is afgevinkt (of heel dicht bij het laatste RD-punt ligt) */
function analyzeVisitedHousesContext(lastPointLatLng, lastPointMs, visitedHouses) {
    if (!visitedHouses || visitedHouses.length === 0) {
        return {
            originBearingDeg: null,
            recentVisitedAnchor: null,
            visitedCentroid: null
        };
    }

    // Zoek het meest recent bezochte clubhuis (indien timestamps bekend zijn) of het dichtstbijzijnde bezochte clubhuis
    var sortedByDistance = visitedHouses.slice().sort(function(a, b) {
        var dA = getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], a.lat, a.lng);
        var dB = getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], b.lat, b.lng);
        return dA - dB;
    });

    var nearestVisited = sortedByDistance[0];
    var nearestDistKm = getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], nearestVisited.lat, nearestVisited.lng);

    // Kijk of er een clubhuis expliciet NA het tijdstip van het laatste RD-punt op bezocht is gezet
    var visitedAfterLastRd = null;
    var latestVisitTs = 0;
    visitedHouses.forEach(function(h) {
        var ts = getHouseVisitedTimestamp(h.name);
        if (ts && ts > 1000 && ts > (lastPointMs + 60000) && ts > latestVisitTs) {
            // Alleen meenemen als het binnen een realistische straal (bijv. 6 km) van het laatste RD-punt ligt
            var d = getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], h.lat, h.lng);
            if (d <= 6.0) {
                latestVisitTs = ts;
                visitedAfterLastRd = h;
            }
        }
    });

    // Bereken het gewogen zwaartepunt (centroid) van de bezochte clubhuizen om de "reeds afgewerkte sector" te kennen
    var sumLat = 0, sumLng = 0, totalW = 0;
    visitedHouses.forEach(function(h) {
        var d = Math.max(0.2, getDistanceKm(lastPointLatLng[0], lastPointLatLng[1], h.lat, h.lng));
        var w = 1 / d; // Dichtbijzijnde bezochte clubs wegen zwaarder mee
        sumLat += h.lat * w;
        sumLng += h.lng * w;
        totalW += w;
    });
    var visitedCentroid = totalW > 0 ? [sumLat / totalW, sumLng / totalW] : [nearestVisited.lat, nearestVisited.lng];

    // De herkomst-richting: vossen liepen VAN het bezochte clubhuis NAAR het huidige RD-punt
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

/* Bepaalt een semi-logische keten van nog niet bezochte clubhuizen (max 2 stappen vooruit)
   op basis van:
   1. Eventueel handmatig gelockt doel-clubhuis door Admin
   2. Afstand vanaf het laatste RD-punt
   3. De huidige looprichting van de RD-lijn
   4. De ligging van reeds BEZOCHTE clubhuizen (vossen zijn daar al geweest voor hun tegenhunt-sticker
      en bewegen zich dus logischerwijs voort vanuit die bezochte route richting de nog onbezochte sector) */
function selectSemiLogicalTargetHouses(lastLatLng, movementBearingDeg, unvisitedHouses, visitedContext, lockedHouseName) {
    if (!unvisitedHouses || unvisitedHouses.length === 0) return [];

    var effectiveStartLatLng = lastLatLng;
    if (visitedContext && visitedContext.recentVisitedAnchor) {
        effectiveStartLatLng = [visitedContext.recentVisitedAnchor.lat, visitedContext.recentVisitedAnchor.lng];
    }

    var primaryTarget = null;

    // 1. Controleer eerst of de Admin handmatig een doel-clubhuis heeft gelockt voor dit deelgebied
    if (lockedHouseName) {
        primaryTarget = unvisitedHouses.find(function(h) { return h.name === lockedHouseName; }) || null;
    }

    // 2. Geen (geldige) lock? Bereken dan het slimste eerstvolgende onbezochte clubhuis
    if (!primaryTarget) {
        var scoredFirst = unvisitedHouses.map(function(h) {
            var distKm = getDistanceKm(effectiveStartLatLng[0], effectiveStartLatLng[1], h.lat, h.lng);
            var bearingToHouse = getBearing(effectiveStartLatLng[0], effectiveStartLatLng[1], h.lat, h.lng);
            var penaltyFactor = 1.0;

            // Factor A: Looprichting van de RD-lijn (laatste RD-punten)
            if (movementBearingDeg !== null) {
                var angleDiff = getAngleDifferenceDeg(movementBearingDeg, bearingToHouse);
                // Recht vooruit (0°) = 0.65 (sterke voorkeur), haaks (90°) = 1.10, achteruit (180°) = 1.60
                penaltyFactor *= (0.65 + (angleDiff / 180) * 0.95);
            }

            // Factor B: Informatie uit reeds BEZOCHTE clubgebouwen (vossen komen daar vandaan!)
            if (visitedContext) {
                if (visitedContext.originBearingDeg !== null) {
                    var originAngleDiff = getAngleDifferenceDeg(visitedContext.originBearingDeg, bearingToHouse);
                    // Als een onbezocht huisje in het verlengde ligt van de lijn [Bezocht Huisje -> Laatste RD-punt],
                    // is dat een hele logische doorgaande route. Moeten ze terug richting het bezochte huisje, dan krijgt het straf.
                    var visitedFlowMultiplier = 0.80 + (originAngleDiff / 180) * 0.50;
                    penaltyFactor *= visitedFlowMultiplier;
                }

                if (visitedContext.visitedCentroid) {
                    // Extra check: ligt dit onbezochte clubhuis verder weg van het bezochte cluster, of midden tussen al bezochte clubs?
                    var distFromVisitedCluster = getDistanceKm(visitedContext.visitedCentroid[0], visitedContext.visitedCentroid[1], h.lat, h.lng);
                    var distStartFromCluster = getDistanceKm(visitedContext.visitedCentroid[0], visitedContext.visitedCentroid[1], effectiveStartLatLng[0], effectiveStartLatLng[1]);
                    if (distFromVisitedCluster > distStartFromCluster) {
                        // Ligt mooi vooruit in nieuw onbezocht gebied
                        penaltyFactor *= 0.92;
                    }
                }
            }

            return {
                house: h,
                distKm: distKm,
                score: distKm * penaltyFactor
            };
        });

        scoredFirst.sort(function(a, b) { return a.score - b.score; });
        primaryTarget = scoredFirst[0].house;
    }

    if (unvisitedHouses.length === 1) {
        return [primaryTarget];
    }

    // Stap 3: Kijk vanaf dit eerste doel-clubhuis wat het meest logische vervolg-clubhuis is (2-staps doorkijk)
    var incomingBearing = getBearing(effectiveStartLatLng[0], effectiveStartLatLng[1], primaryTarget.lat, primaryTarget.lng);
    var remainingHouses = unvisitedHouses.filter(function(h) { return h.name !== primaryTarget.name; });

    var scoredSecond = remainingHouses.map(function(h) {
        var distKm = getDistanceKm(primaryTarget.lat, primaryTarget.lng, h.lat, h.lng);
        var bearingToNext = getBearing(primaryTarget.lat, primaryTarget.lng, h.lat, h.lng);
        var angleDiff = getAngleDifferenceDeg(incomingBearing, bearingToNext);
        var penaltyFactor = 0.70 + (angleDiff / 180) * 0.95;
        return {
            house: h,
            distKm: distKm,
            score: distKm * penaltyFactor
        };
    });

    scoredSecond.sort(function(a, b) { return a.score - b.score; });
    var secondaryTarget = scoredSecond[0].house;

    return [primaryTarget, secondaryTarget];
}

/* Hulpfunctie om een route-array netjes te comprimeren voor Firebase */
function simplifyRouteCoords(rawCoords, maxPoints) {
    var limit = maxPoints || 140;
    var coords = rawCoords.map(function(c) {
        return [
            Math.round(c[1] * 100000) / 100000,
            Math.round(c[0] * 100000) / 100000
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
            // Check op N-wegen (bijv. N224, N325, N801, Provincialeweg, Rijksweg)
            if (/\bN\d{2,3}\b/.test(combined) || combined.includes("PROVINCIALEWEG") || combined.includes("RIJKSWEG")) {
                nRoadMeters += (step.distance || 0);
            }
        });
    });
    return nRoadMeters;
}

/* Berekent de gemiddelde afwijking in meters tussen twee routes om te zien of het echt een andere parallelweg is */
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

/* Haalt zowel de primaire looproute als een doelgerichte alternatieve parallelroute op
   (die N-wegen/drukke wegen mijdt en een parallelweg kiest als dat niet te ver om is) */
async function getPrimaryAndAlternativeWalkingRoutes(waypointsLatLng, wantAlternative) {
    if (!waypointsLatLng || waypointsLatLng.length < 2) {
        return { primary: [], alternative: [] };
    }

    var cacheKey = waypointsLatLng.map(function(pt) {
        return `${pt[0].toFixed(5)},${pt[1].toFixed(5)}`;
    }).join('_') + (wantAlternative ? '_ALT1' : '_ALT0');

    if (walkingRouteCache[cacheKey]) {
        return walkingRouteCache[cacheKey];
    }

    var coordString = waypointsLatLng.map(function(pt) {
        return `${pt[1]},${pt[0]}`;
    }).join(';');

    var endpoints = [
        `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coordString}?overview=full&geometries=geojson&alternatives=true&steps=true`,
        `https://router.project-osrm.org/route/v1/foot/${coordString}?overview=full&geometries=geojson&alternatives=true&steps=true`
    ];

    var primaryCoords = null;
    var altCoords = [];
    var usedEndpointBase = "https://routing.openstreetmap.de/routed-foot/route/v1/foot/";

    for (var i = 0; i < endpoints.length; i++) {
        try {
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, 4500);
            var res = await fetch(endpoints[i], { signal: controller.signal });
            clearTimeout(timeoutId);

            if (res.ok) {
                var data = await res.json();
                if (data && data.routes && data.routes.length > 0) {
                    usedEndpointBase = endpoints[i].split('/route/v1/foot/')[0] + '/route/v1/foot/';
                    var routes = data.routes;
                    primaryCoords = simplifyRouteCoords(routes[0].geometry.coordinates, 130);
                    var primaryDist = routes[0].distance || getPolylineLengthMeters(primaryCoords);

                    // Als OSRM direct al een goed alternatief teruggeeft dat niet meer dan 35% langer is:
                    if (wantAlternative && routes.length > 1) {
                        var bestAlt = null;
                        var bestAltScore = Infinity;

                        for (var rIdx = 1; rIdx < routes.length; rIdx++) {
                            var cand = routes[rIdx];
                            var candDist = cand.distance || 1;
                            // Niet te ver om: maximaal 35% extra afstand
                            if (candDist <= primaryDist * 1.35) {
                                var nPenalty = calculateMainRoadPenalty(cand);
                                var score = candDist + (nPenalty * 3.0); // Straf N-wegen zwaar af
                                if (score < bestAltScore) {
                                    bestAltScore = score;
                                    bestAlt = cand;
                                }
                            }
                        }

                        if (bestAlt && bestAlt.geometry && bestAlt.geometry.coordinates) {
                            altCoords = simplifyRouteCoords(bestAlt.geometry.coordinates, 120);
                        }
                    }
                    break;
                }
            }
        } catch (err) {
            // Probeer volgende endpoint
        }
    }

    if (!primaryCoords) {
        var fallbackRes = { primary: waypointsLatLng, alternative: [] };
        return fallbackRes;
    }

    // Als we een alternatieve parallelroute willen naar het eerstvolgende doel-clubhuis,
    // en de standaard server gaf nog geen tweede parallelroute terug:
    // Bereken een slimme parallel-waypoint (linksom +90° en rechtsom -90° van de hoofdlijn)
    if (wantAlternative && (!altCoords || altCoords.length < 2)) {
        var pStart = waypointsLatLng[0];
        var pTarget = waypointsLatLng[1];
        var directDistMeters = getDistanceKm(pStart[0], pStart[1], pTarget[0], pTarget[1]) * 1000;

        // Alleen zinvol als het doel-clubhuis tussen 250m en 15km ligt
        if (directDistMeters >= 250 && directDistMeters <= 15000) {
            var midLat = (pStart[0] + pTarget[0]) / 2;
            var midLng = (pStart[1] + pTarget[1]) / 2;
            var mainBearing = getBearing(pStart[0], pStart[1], pTarget[0], pTarget[1]);
            // Kies een laterale offset van ~22% van de afstand (begrensd tussen 180m en 650m) om een parallelweg te pakken
            var offsetMeters = Math.min(650, Math.max(180, Math.round(directDistMeters * 0.22)));

            var sideBearings = [(mainBearing + 90) % 360, (mainBearing + 270) % 360];
            var primaryToFirstTargetDist = getPolylineLengthMeters(primaryCoords);
            var bestCandidateCoords = null;
            var bestCandidateScore = Infinity;

            for (var s = 0; s < sideBearings.length; s++) {
                var viaPt = getDestinationLatLng(midLat, midLng, offsetMeters, sideBearings[s]);
                var viaCoordStr = `${pStart[1]},${pStart[0]};${viaPt[1]},${viaPt[0]};${pTarget[1]},${pTarget[0]}`;
                var viaUrl = `${usedEndpointBase}${viaCoordStr}?overview=full&geometries=geojson&steps=true`;

                try {
                    var ctrl2 = new AbortController();
                    var tId2 = setTimeout(function() { ctrl2.abort(); }, 3200);
                    var resVia = await fetch(viaUrl, { signal: ctrl2.signal });
                    clearTimeout(tId2);

                    if (resVia.ok) {
                        var viaData = await resVia.json();
                        if (viaData && viaData.routes && viaData.routes.length > 0) {
                            var rVia = viaData.routes[0];
                            var simpVia = simplifyRouteCoords(rVia.geometry.coordinates, 110);
                            var viaDist = rVia.distance || getPolylineLengthMeters(simpVia);

                            // Controleer of de parallelroute niet te ver om is (max 35% langer dan de directe route naar target 1)
                            // én daadwerkelijk over een andere (parallel)weg loopt (minstens 85m afwijking)
                            var separation = getRouteSeparationMeters(simpVia, primaryCoords);
                            if (viaDist <= primaryToFirstTargetDist * 1.38 && separation >= 85) {
                                var nRoadPen = calculateMainRoadPenalty(rVia);
                                var candidateScore = viaDist + (nRoadPen * 3.5);
                                if (candidateScore < bestCandidateScore) {
                                    bestCandidateScore = candidateScore;
                                    bestCandidateCoords = simpVia;
                                }
                            }
                        }
                    }
                } catch (eVia) {}
            }

            if (bestCandidateCoords) {
                altCoords = bestCandidateCoords;
            }
        }
    }

    var result = {
        primary: primaryCoords,
        alternative: altCoords || []
    };
    walkingRouteCache[cacheKey] = result;
    return result;
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

/* --- 2. SLIMME SNELHEIDSBEREKENING (MAX 7 KM/U FILTER & 50/50 WEGING) --- */
function getValidSpeedSegments(pts) {
    var maxAllowedKmh = Number(adminSettings.maxWalkingSpeedKmh) || 7.0;
    var segments = [];

    for (var i = 0; i < pts.length - 1; i++) {
        var pA = pts[i];
        var pB = pts[i + 1];
        var t1 = getPointTimestampMs(pA);
        var t2 = getPointTimestampMs(pB);

        if (t2 <= t1) continue;

        var distKm = getDistanceKm(pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1]);
        var hours = (t2 - t1) / 3600000;
        if (hours > 0) {
            var kmh = distKm / hours;
            if (kmh <= maxAllowedKmh && kmh > 0) {
                segments.push(kmh);
            }
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

function calculateAreaWalkingSpeed(areaPoints) {
    var defaultKmh = Number(adminSettings.defaultSpeedKmh) || 6.5;

    var huntPoints = areaPoints.filter(function(p) {
        return (p.pointType || p.baseName) === "Hunt";
    });

    var huntSegments = getValidSpeedSegments(huntPoints);
    if (huntSegments.length > 0) {
        var rawHuntSpeed = computeWeightedSpeedFromSegments(huntSegments);
        var clampedHunt = Math.min(7.0, Math.max(0.5, rawHuntSpeed));
        var displayHunt = Math.round(clampedHunt * 10) / 10;
        return {
            speedKmh: clampedHunt,
            speedText: `~${displayHunt} km/u (Hunt)`
        };
    }

    var huntAndHintPoints = areaPoints.filter(function(p) {
        var t = p.pointType || p.baseName || "Hint";
        return t === "Hunt" || t === "Hint";
    });

    var combinedSegments = getValidSpeedSegments(huntAndHintPoints);
    if (combinedSegments.length > 0) {
        var rawCombinedSpeed = computeWeightedSpeedFromSegments(combinedSegments);
        var clampedCombined = Math.min(7.0, Math.max(0.5, rawCombinedSpeed));
        var displayCombined = Math.round(clampedCombined * 10) / 10;
        return {
            speedKmh: clampedCombined,
            speedText: `~${displayCombined} km/u (incl. Hint)`
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
    var areaStatusList = document.getElementById('admin-area-growth-list');

    if (!statusDot || !labelEl || !subtextEl) return;

    var activeAreas = Object.keys(areaCappedStatus);
    var anyCapped = activeAreas.some(function(a) { return areaCappedStatus[a].isCapped; });

    // 1. Balletje bij Max. groeitijd: groen als max groeitijd nog niet gehaald is, rood als deze bereikt is
    statusDot.className = 'admin-status-dot ' + (anyCapped ? 'status-dot-red' : 'status-dot-green');
    statusDot.title = anyCapped
        ? 'Maximale groeitijd is bereikt voor één of meer gebieden'
        : 'Groei actief (maximale groeitijd nog niet bereikt)';

    // Tekstkleur: donkergrijs (#95a5a6) als max groeitijd nog niet gehaald is, lichtere grijstint (#dcdde1) als max bereikt is
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

    // 3. Overzicht per actief deelgebied met eigen groen/rood balletje én Doel-Clubhuis Lock dropdown
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

            var speedResult = calculateAreaWalkingSpeed(points);
            var calculatedSpeedKmh = speedResult.speedKmh;
            var speedText = speedResult.speedText;

            // 1. Bepaal de pure looprichting van de vossen op basis van hun RD-lijn (laatste 2 à 3 punten)
            var lineMovementBearingDeg = null;
            if (points.length >= 2) {
                var mSin = 0, mCos = 0, mWeight = 0;
                var pA = points[points.length - 2];
                var pB = points[points.length - 1];
                var b1 = getBearing(pA.latlng[0], pA.latlng[1], pB.latlng[0], pB.latlng[1]) * Math.PI / 180;
                mSin += 0.80 * Math.sin(b1); mCos += 0.80 * Math.cos(b1); mWeight += 0.80;

                if (points.length >= 3) {
                    var pA2 = points[points.length - 3];
                    var pB2 = points[points.length - 2];
                    var b2 = getBearing(pA2.latlng[0], pA2.latlng[1], pB2.latlng[0], pB2.latlng[1]) * Math.PI / 180;
                    mSin += 0.20 * Math.sin(b2); mCos += 0.20 * Math.cos(b2); mWeight += 0.20;
                }
                if (mWeight > 0) {
                    var avgMoveRad = Math.atan2(mSin / mWeight, mCos / mWeight);
                    lineMovementBearingDeg = ((avgMoveRad * 180 / Math.PI) + 360) % 360;
                }
            }

            // 2. Splits de clubgebouwen van dit deelgebied in BEZOCHT en ONBEZOCHT
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

            // 3. Analyseer de al BEZOCHTE clubgebouwen (waar de vossen al langs zijn geweest voor hun tegenhunt-sticker)
            var visitedContext = analyzeVisitedHousesContext(lastPoint.latlng, lastPtMs, visitedHouses);

            // Controleer of er voor dit gebied een handmatig gelockt doel-clubhuis is ingesteld
            var lockedTargetName = (adminSettings.lockedTargets && adminSettings.lockedTargets[area])
                ? adminSettings.lockedTargets[area]
                : null;

            // Als het gelockte clubhuis inmiddels op 'bezocht' is gezet, negeer de lock dan automatisch
            if (lockedTargetName && !unvisitedHouses.some(function(h) { return h.name === lockedTargetName; })) {
                lockedTargetName = null;
            }

            // Selecteer de semi-logische keten van onbezochte clubhuizen (rekening houdend met lock, RD-lijn én bezochte clubs)
            var targetHousesChain = selectSemiLogicalTargetHouses(
                lastPoint.latlng,
                lineMovementBearingDeg,
                unvisitedHouses,
                visitedContext,
                lockedTargetName
            );
            var primaryTargetHouse = targetHousesChain.length > 0 ? targetHousesChain[0] : null;

            // 4. Bereken de gecombineerde richtingshoek voor de gradenhoek-pijlen op de cirkel
            //    (Neemt nu óók de herkomst vanaf bezochte clubgebouwen mee!)
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

                // Neem de wegloop-richting vanaf reeds bezochte clubgebouwen mee voor 20%
                if (visitedContext.originBearingDeg !== null) {
                    var bVisitedOrigin = visitedContext.originBearingDeg * Math.PI / 180;
                    sumSin += 0.20 * Math.sin(bVisitedOrigin); sumCos += 0.20 * Math.cos(bVisitedOrigin); totalWeight += 0.20;
                }

                // Neem de richting naar het voorspelde/gelockte onbezochte clubhuis mee voor 35%
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

            var baseAreaColor = areaColors[area] || "#e74c3c";
            // Als de maximale groeitijd verstreken is, wordt de cirkel op de kaart grijs (#7f8c8d)
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

            // 5. Bereken zowel de primaire voorspellende looproute als (indien ingeschakeld) de alternatieve parallelroute
            var estimatedWalkRoute = [];
            var alternativeWalkRoute = [];
            var estimatedTargetHouseName = "";
            var visitedOriginHouseName = visitedContext.nearestVisited ? visitedContext.nearestVisited.name : "";
            var circleIntersectionPoint = null;
            var liveExpectedFoxPoint = null;
            var altLiveExpectedFoxPoint = null;

            if (targetHousesChain.length > 0) {
                var waypoints = [lastPoint.latlng];
                // Als een clubhuis ná het laatste RD-punt op bezocht is gezet, neem die dan mee als bevestigd tussenpunt!
                if (visitedContext.recentVisitedAnchor) {
                    waypoints.push([visitedContext.recentVisitedAnchor.lat, visitedContext.recentVisitedAnchor.lng]);
                }
                targetHousesChain.forEach(function(h) {
                    waypoints.push([h.lat, h.lng]);
                });

                var lockPrefix = lockedTargetName ? "🔒 " : "";
                estimatedTargetHouseName = lockPrefix + targetHousesChain.map(function(h) { return h.name; }).join(" ➔ ");

                var routesObj = await getPrimaryAndAlternativeWalkingRoutes(waypoints, !!adminSettings.showAltQuietRoute);
                estimatedWalkRoute = routesObj.primary || [];
                alternativeWalkRoute = routesObj.alternative || [];

                if (!isFuture && estimatedWalkRoute && estimatedWalkRoute.length >= 2) {
                    // A. Snijpunt waar de geschatte looproute en de groeiende cirkel elkaar kruisen
                    circleIntersectionPoint = findRouteCircleIntersection(
                        lastPoint.latlng,
                        currentRadiusMeters,
                        estimatedWalkRoute
                    );

                    // B. Live verwachte positie van de vos langs de primaire wandelroute o.b.v. gemiddelde snelheid
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

                // C. Live verwachte positie op de alternatieve parallel/rustige route
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
                routeCoords: points.length >= 2 ? points.map(function(p) { return p.latlng; }) : [],
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
            width: 268px; max-width: 84vw;
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
        /* Standaard donkergrijs (#95a5a6) wanneer max groeitijd nog NIET gehaald is;
           wordt lichtere grijstint (#dcdde1) zodra max groeitijd bereikt is */
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
        #admin-alt-route-toggle {
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
                    Berekent een 2e doelgerichte route die drukke N-wegen mijdt en parallelwegen kiest indien niet te ver om.
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