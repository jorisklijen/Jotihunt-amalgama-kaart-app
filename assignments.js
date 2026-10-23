/* ==========================================================================
   4. ASSIGNMENTS.JS - OPDRACHTEN TRACKER + VEILIGE TWEE-WEG GOOGLE SHEETS SYNC
   - Admins kunnen Opdrachtnaam + Deadline (datum & tijd) bewerken via modal
   - Handmatig gewijzigde status na Telegram/Afgerond blijft altijd behouden
   - Nieuwe opdrachten in Google Sheets verdwijnen nooit meer bij het schrijven
   - 10-minuten deadline melding met 30s witte voortgangsbalk (+ 0.5s sluit-delay)
   ========================================================================== */

var assignmentsData = {};
var deletedAssignmentsMap = {};
var notifiedTenMinDeadlines = {};
var expandedFieldMemory = {};
var sheetWriteDebounceTimer = null;
var isPushingToSheet = false;
var currentEditingAssignmentKey = null;
var deadlineBannerTimer = null;
var deadlineBannerCloseTimeout = null;

// Configuratie voor jullie live Google Sheet (tabblad gid=1344677603)
var GOOGLE_SHEET_ID = "1lZTXRRbvy8ODGgZheOpm3qUdFOu8mM1muhxOyeStks4";
var GOOGLE_SHEET_GID = "1344677603";
var GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/" + GOOGLE_SHEET_ID + "/export?format=csv&gid=" + GOOGLE_SHEET_GID;

// Vaste Google Apps Script Web-App URL voor twee-weg synchronisatie (schrijven naar de Sheet)
var GOOGLE_SHEET_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxH-Q0BZLqy931z4Htrm1NEZABcxieIq0yKAjQtkt2tMwEbDceNe6AGfnLZoqHtpAVElA/exec";

db.ref('adminSettings/sheetWebAppUrl').on('value', function(snap) {
    if (snap.val()) {
        GOOGLE_SHEET_WEBAPP_URL = snap.val();
    }
});

/* Luister naar handmatig verwijderde opdrachten (via de Wis-knop in de app) */
db.ref('deletedAssignments').on('value', function(snapshot) {
    deletedAssignmentsMap = snapshot.val() || {};
    renderAssignmentsList();
});

function makeTitleSlug(title) {
    return String(title || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 60);
}

window.isAssignmentDeleted = function(id, title) {
    if (id && deletedAssignmentsMap[id]) return true;
    var slug = makeTitleSlug(title);
    if (slug && deletedAssignmentsMap['slug_' + slug]) return true;
    return false;
};

/* Luister realtime naar alle opdrachten in Firebase */
db.ref('assignments').on('value', function(snapshot) {
    assignmentsData = snapshot.val() || {};
    enforceAutomaticAssignmentStatuses();
    updatePointsSummary();
    renderAssignmentsList();
    checkAdminDeadlineNotifications();
});

/* Luister naar binnenkomende Telegram beoordelingen en koppel ze éénmalig aan de juiste opdracht */
db.ref('telegramData/assignments').on('value', function(snapshot) {
    var tgItems = snapshot.val();
    if (!tgItems) return;

    var updatesPromiseList = [];

    Object.keys(tgItems).forEach(function(tgKey) {
        var tg = tgItems[tgKey];
        if (!tg || tg.linkedToAssignment || !tg.title) return;

        if (window.isAssignmentDeleted(null, tg.title)) {
            db.ref('telegramData/assignments/' + tgKey).update({ linkedToAssignment: 'deleted' });
            return;
        }

        var cleanTgTitle = tg.title.toLowerCase().trim();
        var matchedId = Object.keys(assignmentsData).find(function(id) {
            var aTitle = String(assignmentsData[id].title || '').toLowerCase().trim();
            return aTitle && (aTitle.includes(cleanTgTitle) || cleanTgTitle.includes(aTitle));
        });

        if (matchedId) {
            var p1 = db.ref('assignments/' + matchedId).update({
                earnedPoints: tg.points !== undefined ? tg.points : null,
                feedback: tg.feedback || tg.rawMessage || "Beoordeeld via Telegram",
                status: "Afgerond",
                manualStatusOverride: false,
                updatedAt: Date.now()
            });
            var p2 = db.ref('telegramData/assignments/' + tgKey).update({ linkedToAssignment: matchedId });
            updatesPromiseList.push(p1, p2);
        } else {
            var newId = 'tg_' + tgKey.replace(/[^a-zA-Z0-9_-]/g, '');
            var ts = tg.timestamp || Date.now();
            var newAssignmentObj = {
                id: newId,
                title: tg.title,
                url: "https://jotihunt.nl/",
                createdAt: ts,
                deadlineTimestamp: ts,
                deadlineFormatted: formatDeadlineDateAndTime(ts, tg.timeFormatted),
                maxPoints: tg.maxPoints || Math.max(0, tg.points || 0),
                earnedPoints: tg.points !== undefined ? tg.points : 0,
                feedback: tg.feedback || tg.rawMessage || "",
                status: "Afgerond",
                manualStatusOverride: false,
                assignedTo: "",
                notes: "Automatisch aangemaakt vanuit Telegram",
                updatedAt: Date.now()
            };
            var p3 = db.ref('assignments/' + newId).set(newAssignmentObj);
            var p4 = db.ref('telegramData/assignments/' + tgKey).update({ linkedToAssignment: newId });
            updatesPromiseList.push(p3, p4);
        }
    });

    if (updatesPromiseList.length > 0) {
        Promise.all(updatesPromiseList).then(function() {
            schedulePushAssignmentsToGoogleSheet(400);
        });
    }
});

/* ==========================================================================
   SLIMME DATUM + TIJD PARSER (INCL. 22:00 NAAR 01:00 NACHT-OVERGANG)
   ========================================================================== */

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function toLocalDatetimeInputValue(dateObj) {
    var d = (dateObj instanceof Date && !isNaN(dateObj.getTime())) ? dateObj : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function formatDeadlineDateAndTime(timestampMs, fallbackStr) {
    if (!timestampMs || isNaN(timestampMs)) {
        return fallbackStr || "Geen datum";
    }
    var d = new Date(Number(timestampMs));
    if (isNaN(d.getTime())) return fallbackStr || "Geen datum";
    return pad2(d.getDate()) + "-" + pad2(d.getMonth() + 1) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function parseSheetDeadline(deadlineStr, referenceCreatedMs) {
    if (!deadlineStr) return null;
    var clean = String(deadlineStr).trim();
    if (!clean || clean.toLowerCase() === 'geen datum' || clean.toLowerCase() === 'beoordeeld') return null;

    var refTime = referenceCreatedMs ? new Date(Number(referenceCreatedMs)) : new Date();
    if (isNaN(refTime.getTime())) refTime = new Date();
    var currentYear = refTime.getFullYear();

    var dmyMatch = clean.match(/^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (dmyMatch) {
        var day = parseInt(dmyMatch[1], 10);
        var month = parseInt(dmyMatch[2], 10) - 1;
        var year = dmyMatch[3] ? parseInt(dmyMatch[3], 10) : currentYear;
        if (year < 100) year += 2000;
        var hour = parseInt(dmyMatch[4], 10);
        var min = parseInt(dmyMatch[5], 10);
        return new Date(year, month, day, hour, min, 0, 0).getTime();
    }

    var timeOnlyMatch = clean.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (timeOnlyMatch) {
        var targetHour = parseInt(timeOnlyMatch[1], 10);
        var targetMin = parseInt(timeOnlyMatch[2], 10);

        var candidate = new Date(
            refTime.getFullYear(),
            refTime.getMonth(),
            refTime.getDate(),
            targetHour,
            targetMin,
            0,
            0
        );

        if (candidate.getTime() < refTime.getTime() - (2 * 3600 * 1000)) {
            candidate.setDate(candidate.getDate() + 1);
        }

        return candidate.getTime();
    }

    var parsed = Date.parse(clean);
    if (!isNaN(parsed)) return parsed;

    return null;
}

/* ==========================================================================
   AUTOMATISCHE STATUS-REGELS MET BEHOUD VAN HANDMATIGE STATUS-WIJZIGINGEN:
   - Als iemand handmatig de status van een (Telegram) opdracht wijzigt
     (manualStatusOverride === true), dwingt de app hem NIET meer terug naar 'Afgerond'!
   - Deadline verlopen geldt alleen als de opdracht nog op 'Open' of 'Bezig' stond.
   ========================================================================== */

function hasPointsOrFeedback(item) {
    if (!item) return false;
    var hasEarned = item.earnedPoints !== undefined && item.earnedPoints !== null && String(item.earnedPoints).trim() !== '' && String(item.earnedPoints).trim() !== '-';
    var fb = String(item.feedback || '').trim();
    var hasFb = fb !== '' && fb.toLowerCase() !== 'nog geen beoordeling' && fb.toLowerCase() !== 'geen feedback';
    return hasEarned || hasFb;
}

function computeDesiredStatus(item) {
    var currentStatus = item.status || 'Open';

    // Regel 1: Als er behaalde punten en/of feedback zijn ingevuld
    if (hasPointsOrFeedback(item) && !item.manualStatusOverride) {
        return 'Afgerond';
    }

    if (item.deadlineTimestamp && !isNaN(item.deadlineTimestamp)) {
        var now = Date.now();
        var deadline = Number(item.deadlineTimestamp);
        var isPast = deadline < now;
        var isExpiredBy3Hours = (now - deadline) > (3 * 3600 * 1000); // 3 uur voorbij de deadline

        // NIEUW: Als hij 3 uur of langer verlopen is, en momenteel 'Deadline verlopen' is (of zou worden)
        if (isPast && isExpiredBy3Hours) {
            if (currentStatus === 'Deadline verlopen' || (!item.manualStatusOverride && currentStatus !== 'Ingeleverd' && currentStatus !== 'Afgerond')) {
                return 'Afgerond';
            }
        }

        // Regel 2: Deadline net verlopen (maar nog geen 3 uur), en NIET op 'Ingeleverd' of 'Afgerond'
        if (isPast && currentStatus !== 'Ingeleverd' && currentStatus !== 'Afgerond' && !item.manualStatusOverride) {
            return 'Deadline verlopen';
        }
        
        // Regel 3: Als de deadline naar de toekomst is verplaatst, herstel de status
        if (!isPast && currentStatus === 'Deadline verlopen') {
            return item.assignedTo ? 'Bezig' : 'Open';
        }
    }

    return currentStatus;
}

function enforceAutomaticAssignmentStatuses() {
    var batchUpdates = {};
    var hasChanges = false;

    Object.keys(assignmentsData).forEach(function(key) {
        var item = assignmentsData[key];
        if (!item) return;

        if (window.isAssignmentDeleted(key, item.title)) {
            delete assignmentsData[key];
            batchUpdates[key] = null;
            hasChanges = true;
            return;
        }

        var desiredStatus = computeDesiredStatus(item);
        var needsStatusUpdate = desiredStatus !== item.status;

        var formattedWithDate = item.deadlineTimestamp
            ? formatDeadlineDateAndTime(item.deadlineTimestamp, item.deadlineFormatted)
            : (item.deadlineFormatted || "Geen datum");
        var needsDateFormatUpdate = item.deadlineTimestamp && formattedWithDate !== item.deadlineFormatted;

        if (needsStatusUpdate) {
            item.status = desiredStatus;
            batchUpdates[key + '/status'] = desiredStatus;
            batchUpdates[key + '/updatedAt'] = Date.now();
            hasChanges = true;
        }
        if (needsDateFormatUpdate) {
            item.deadlineFormatted = formattedWithDate;
            batchUpdates[key + '/deadlineFormatted'] = formattedWithDate;
            hasChanges = true;
        }
    });

    if (hasChanges) {
        db.ref('assignments').update(batchUpdates);
        schedulePushAssignmentsToGoogleSheet();
    }
}

/* ==========================================================================
   VEILIGE TWEE-WEG GOOGLE SHEETS SYNCHRONISATIE
   Haalt altijd eerst eventuele nieuw toegevoegde rijen uit de Sheet op
   voordat er teruggeschreven wordt, zodat nieuwe Sheet-opdrachten nooit verdwijnen!
   ========================================================================== */

async function fetchRawGoogleSheetCsv() {
    var csvText = null;
    var targetUrl = GOOGLE_SHEET_CSV_URL + "&t=" + Date.now();

    try {
        var res = await fetch(targetUrl, { cache: "no-store" });
        if (res.ok) csvText = await res.text();
    } catch (e) {}

    if (!csvText) {
        try {
            var proxyUrl = "https://jotihunt-proxy.joriskleijn2000.workers.dev/?url=" + encodeURIComponent(targetUrl);
            var proxyRes = await fetch(proxyUrl, { cache: "no-store" });
            if (proxyRes.ok) csvText = await proxyRes.text();
        } catch (proxyErr) {}
    }

    if (!csvText || csvText.trim().startsWith("<!DOCTYPE html>")) {
        return null;
    }
    return csvText;
}

function parseCSVToRows(csvText) {
    var rows = [];
    var currentRow = [];
    var currentVal = "";
    var inQuotes = false;

    for (var i = 0; i < csvText.length; i++) {
        var char = csvText[i];
        var nextChar = csvText[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                currentVal += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            currentRow.push(currentVal.trim());
            currentVal = "";
        } else if ((char === '\r' || char === '\n') && !inQuotes) {
            if (char === '\r' && nextChar === '\n') i++;
            currentRow.push(currentVal.trim());
            if (currentRow.some(function(cell) { return cell !== ""; })) {
                rows.push(currentRow);
            }
            currentRow = [];
            currentVal = "";
        } else {
            currentVal += char;
        }
    }
    if (currentVal !== "" || currentRow.length > 0) {
        currentRow.push(currentVal.trim());
        if (currentRow.some(function(cell) { return cell !== ""; })) {
            rows.push(currentRow);
        }
    }
    return rows;
}

function normalizeSheetStatus(rawStatus) {
    var s = String(rawStatus || '').toLowerCase().trim();
    if (s.includes('verlopen') || s.includes('te laat') || s.includes('gemist')) return 'Deadline verlopen';
    if (s.includes('afgerond') || s.includes('klaar') || s.includes('gereed') || s.includes('beoordeeld') || s === 'done') return 'Afgerond';
    if (s.includes('ingeleverd') || s.includes('verstuurd') || s.includes('verzonden')) return 'Ingeleverd';
    if (s.includes('bezig') || s.includes('actief') || s.includes('opgepakt') || s.includes('doing')) return 'Bezig';
    return 'Open';
}

/* Verwerk de CSV-rijen uit Google Sheets naar Firebase zonder nieuwe Sheet-rijen kwijt te raken */
async function importRowsFromSheetCsv(csvText, isPrePushCheck) {
    var rows = parseCSVToRows(csvText);
    if (rows.length < 2) return 0;

    var headers = rows[0].map(function(h) { return String(h || '').toLowerCase().trim(); });

    function findCol(keywords, fallbackIdx) {
        var idx = headers.findIndex(function(h) {
            return keywords.some(function(kw) { return h.includes(kw); });
        });
        return idx !== -1 ? idx : fallbackIdx;
    }

    var colTitle    = findCol(['opdracht', 'titel', 'onderwerp', 'taak'], 0);
    var colStatus   = findCol(['status', 'voortgang', 'staat'], 1);
    var colDeadline = findCol(['deadline', 'tijd', 'inlever', 'eindtijd'], 2);
    var colAssignee = findCol(['opgepakt', 'wie', 'persoon', 'door', 'uitvoerder'], 3);
    var colEarned   = findCol(['behaald', 'gekregen', 'score', 'punten'], 4);
    var colMax      = findCol(['max', 'te behalen', 'punten', 'totaal'], 4);
    var colFeedback = findCol(['feedback', 'beoordeling', 'jury', 'telegram'], 5);
    var colNotes    = findCol(['opmerking', 'notitie', 'info', 'toelichting', 'omschrijving', 'wat willen we zien'], 6);

    var updatesBatch = {};
    var syncedCount = 0;

    for (var r = 1; r < rows.length; r++) {
        var row = rows[r];
        var title = row[colTitle] ? String(row[colTitle]).trim() : "";
        if (!title) continue;

        var safeSlug = makeTitleSlug(title);
        var itemId = "sheet_" + (safeSlug || ("row_" + r));

        var existingId = Object.keys(assignmentsData).find(function(k) {
            return k === itemId || (assignmentsData[k] && String(assignmentsData[k].title || '').toLowerCase().trim() === title.toLowerCase());
        });
        var targetKey = existingId || itemId;

        // Negeer alleen als deze opdracht expliciet via de rode Wis-knop in de app is verwijderd
        if (window.isAssignmentDeleted(targetKey, title)) {
            continue;
        }

        var existingObj = assignmentsData[targetKey] || null;

        // Bij een pre-push check voegen we ALLEEN opdrachten toe die nieuw in de Google Sheet zijn getypt
        // zodat we lokale wijzigingen in de app niet overschrijven met een oude CSV-cache.
        if (isPrePushCheck && existingObj) {
            continue;
        }

        // Als een bestaande opdracht korter dan 25s geleden in de app is gewijzigd, heeft de app voorrang
        if (existingObj && existingObj.updatedAt && (Date.now() - existingObj.updatedAt < 25000)) {
            continue;
        }

        var baseObj = existingObj || {};
        var rawStatus = row[colStatus] !== undefined ? row[colStatus] : "";
        var rawDeadline = row[colDeadline] !== undefined ? row[colDeadline] : "";
        var rawAssignee = row[colAssignee] !== undefined ? String(row[colAssignee]).trim() : "";
        var rawFeedback = row[colFeedback] !== undefined ? String(row[colFeedback]).trim() : "";
        var rawNotes = row[colNotes] !== undefined ? String(row[colNotes]).trim() : "";

        if (rawAssignee.length > 35 || rawAssignee.toLowerCase().startsWith("wat willen we zien")) {
            if (!rawNotes) rawNotes = rawAssignee;
            rawAssignee = baseObj.assignedTo && baseObj.assignedTo.length <= 35 ? baseObj.assignedTo : "";
        }

        var earnedPoints = baseObj.earnedPoints !== undefined ? baseObj.earnedPoints : null;
        var maxPoints = baseObj.maxPoints !== undefined ? baseObj.maxPoints : null;

        var rawPointsCell = row[colEarned] !== undefined ? String(row[colEarned]).trim() : "";
        if (rawPointsCell.includes('/')) {
            var parts = rawPointsCell.split('/');
            var pEarned = parseFloat(parts[0].replace(',', '.'));
            var pMax = parseFloat(parts[1].replace(',', '.'));
            earnedPoints = !isNaN(pEarned) ? pEarned : null;
            maxPoints = !isNaN(pMax) ? pMax : maxPoints;
        } else if (rawPointsCell !== "" && rawPointsCell !== "-") {
            var numEarned = parseFloat(rawPointsCell.replace(',', '.'));
            if (!isNaN(numEarned)) {
                if (colEarned === colMax && baseObj.earnedPoints === undefined) {
                    maxPoints = numEarned;
                } else {
                    earnedPoints = numEarned;
                }
            }
            if (colMax !== colEarned && row[colMax] !== undefined) {
                var numMax = parseFloat(String(row[colMax]).replace(',', '.'));
                if (!isNaN(numMax)) maxPoints = numMax;
            }
        }

        var createdAtMs = baseObj.createdAt || Date.now();
        var parsedDeadlineTs = parseSheetDeadline(rawDeadline, createdAtMs) || baseObj.deadlineTimestamp || null;
        var formattedDeadline = parsedDeadlineTs
            ? formatDeadlineDateAndTime(parsedDeadlineTs, rawDeadline)
            : (rawDeadline || baseObj.deadlineFormatted || "Geen datum");

        var sheetStatusNorm = rawStatus ? normalizeSheetStatus(rawStatus) : (baseObj.status || "Open");

        var mergedItem = {
            id: targetKey,
            title: title,
            url: baseObj.url || "https://jotihunt.nl/",
            createdAt: createdAtMs,
            status: sheetStatusNorm,
            manualStatusOverride: baseObj.manualStatusOverride || false,
            deadlineFormatted: formattedDeadline,
            deadlineTimestamp: parsedDeadlineTs,
            assignedTo: rawAssignee !== "" ? rawAssignee : (baseObj.assignedTo || ""),
            earnedPoints: earnedPoints,
            maxPoints: maxPoints,
            feedback: rawFeedback !== "" ? rawFeedback : (baseObj.feedback || ""),
            notes: rawNotes !== "" ? rawNotes : (baseObj.notes || ""),
            updatedAt: baseObj.updatedAt || Date.now()
        };

        mergedItem.status = computeDesiredStatus(mergedItem);
        assignmentsData[targetKey] = mergedItem;
        updatesBatch[targetKey] = mergedItem;
        syncedCount++;
    }

    if (Object.keys(updatesBatch).length > 0) {
        await db.ref('assignments').update(updatesBatch);
    }
    return syncedCount;
}

window.pushAssignmentsToGoogleSheet = async function(skipPreFetch) {
    if (!GOOGLE_SHEET_WEBAPP_URL || isPushingToSheet) return;
    isPushingToSheet = true;

    try {
        // Haal eerst eventuele net in de Google Sheet getypte rijen op zodat die nooit worden overschreven!
        if (!skipPreFetch) {
            var latestCsv = await fetchRawGoogleSheetCsv();
            if (latestCsv) {
                await importRowsFromSheetCsv(latestCsv, true);
            }
        }

        var sorted = getSortedAssignments();
        var rowsPayload = sorted.map(function(item) {
            var hasEarned = item.earnedPoints !== undefined && item.earnedPoints !== null && item.earnedPoints !== '';
            var hasMax = item.maxPoints !== undefined && item.maxPoints !== null && item.maxPoints !== '';
            var pointsStr = "";
            if (hasEarned && hasMax) {
                pointsStr = item.earnedPoints + " / " + item.maxPoints;
            } else if (hasEarned) {
                pointsStr = String(item.earnedPoints);
            } else if (hasMax) {
                pointsStr = "- / " + item.maxPoints;
            }

            var dlFormatted = item.deadlineTimestamp
                ? formatDeadlineDateAndTime(item.deadlineTimestamp, item.deadlineFormatted)
                : (item.deadlineFormatted || "Geen datum");

            return {
                title: item.title || "",
                status: item.status || "Open",
                deadlineFormatted: dlFormatted,
                assignedTo: item.assignedTo || "",
                pointsFormatted: pointsStr,
                feedback: item.feedback || "",
                notes: item.notes || ""
            };
        });

        await fetch(GOOGLE_SHEET_WEBAPP_URL, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ rows: rowsPayload })
        });
    } catch (err) {
        console.warn("Kon niet naar Google Sheet schrijven:", err);
    } finally {
        setTimeout(function() { isPushingToSheet = false; }, 1200);
    }
};

function schedulePushAssignmentsToGoogleSheet(delayMs) {
    if (sheetWriteDebounceTimer) clearTimeout(sheetWriteDebounceTimer);
    sheetWriteDebounceTimer = setTimeout(function() {
        window.pushAssignmentsToGoogleSheet(false);
    }, delayMs || 800);
}

window.syncAssignmentsFromGoogleSheet = async function(showFeedback) {
    if (isPushingToSheet) return;

    var csvText = await fetchRawGoogleSheetCsv();
    if (!csvText) {
        if (showFeedback) alert("Kon de Google Sheet niet uitlezen. Controleer of het bestand openbaar staat ingesteld.");
        return;
    }

    var count = await importRowsFromSheetCsv(csvText, false);
    schedulePushAssignmentsToGoogleSheet(600);

    if (showFeedback) {
        alert("Google Sheet succesvol gesynchroniseerd (" + count + " opdrachten gecontroleerd).");
    }
};

var originalSyncFromApi = window.syncAssignmentsFromApi;
window.syncAssignmentsFromApi = function(showFeedback) {
    if (typeof originalSyncFromApi === 'function') {
        originalSyncFromApi(false);
    }
    window.syncAssignmentsFromGoogleSheet(showFeedback);
};

/* ==========================================================================
   OPDRACHT VERWIJDEREN (KOMT NOOIT MEER TERUG UIT SHEET OF FIREBASE)
   ========================================================================== */

window.deleteSingleAssignment = function(key) {
    if (typeof isAdmin === 'undefined' || !isAdmin) return;
    var item = assignmentsData[key];
    var title = item && item.title ? item.title : key;

    if (!confirm("Weet je zeker dat je de opdracht '" + title + "' definitief wilt verwijderen?")) {
        return;
    }

    var slug = makeTitleSlug(title);
    var delUpdates = {};
    delUpdates[key] = Date.now();
    if (slug) delUpdates['slug_' + slug] = Date.now();

    db.ref('deletedAssignments').update(delUpdates).then(function() {
        delete assignmentsData[key];
        return db.ref('assignments/' + key).remove();
    }).then(function() {
        window.pushAssignmentsToGoogleSheet(true);
    });
};

/* Bereken totaaloverzicht van behaalde en maximaal te behalen punten */
function updatePointsSummary() {
    var totalEarned = 0;
    var totalMax = 0;
    var activeCount = 0;

    Object.keys(assignmentsData).forEach(function(key) {
        var item = assignmentsData[key];
        if (!item || window.isAssignmentDeleted(key, item.title)) return;

        var maxP = parseFloat(item.maxPoints);
        if (!isNaN(maxP) && maxP > 0) totalMax += maxP;

        var earnedP = parseFloat(item.earnedPoints);
        if (!isNaN(earnedP)) totalEarned += earnedP;

        if (item.status === 'Open' || item.status === 'Bezig') {
            activeCount++;
        }
    });

    var earnedEl = document.getElementById('points-earned-total');
    var maxEl = document.getElementById('points-max-total');
    var activeEl = document.getElementById('assignments-active-count');

    if (earnedEl) earnedEl.innerText = totalEarned;
    if (maxEl) maxEl.innerText = totalMax;
    if (activeEl) activeEl.innerText = activeCount;
}

/* ==========================================================================
   SORTERING OP STATUS-GROEP ÉN DEADLINE:
   1. Open (bovenaan) -> 2. Bezig -> 3. Deadline verlopen -> 4. Ingeleverd -> 5. Afgerond (onderaan)
   ========================================================================== */

function getStatusSortRank(status) {
    var s = String(status || 'Open').trim();
    if (s === 'Open') return 1;
    if (s === 'Bezig') return 2;
    if (s === 'Deadline verlopen') return 3;
    if (s === 'Ingeleverd') return 4;
    if (s === 'Afgerond') return 5;
    return 1;
}

function getSortedAssignments() {
    var list = [];
    Object.keys(assignmentsData).forEach(function(k) {
        var item = assignmentsData[k];
        if (!item || window.isAssignmentDeleted(k, item.title)) return;
        var obj = Object.assign({}, item);
        obj.key = k;
        list.push(obj);
    });

    list.sort(function(a, b) {
        var rankA = getStatusSortRank(a.status);
        var rankB = getStatusSortRank(b.status);

        if (rankA !== rankB) {
            return rankA - rankB;
        }

        var tA = a.deadlineTimestamp ? Number(a.deadlineTimestamp) : Infinity;
        var tB = b.deadlineTimestamp ? Number(b.deadlineTimestamp) : Infinity;

        if (tA !== tB) {
            return tA - tB;
        }
        return String(a.title || '').localeCompare(String(b.title || ''));
    });

    return list;
}

function formatRemainingTime(deadlineMs) {
    if (!deadlineMs || isNaN(deadlineMs)) return "Geen eindtijd";
    var diffMs = Number(deadlineMs) - Date.now();
    var diffMin = Math.ceil(diffMs / 60000);

    if (diffMin < 0) {
        var passedMin = Math.abs(diffMin);
        if (passedMin < 60) return "Verlopen (" + passedMin + "m geleden)";
        return "Verlopen (" + Math.floor(passedMin / 60) + "u geleden)";
    }
    if (diffMin <= 10) {
        return "URGENT: nog " + diffMin + " min";
    }
    if (diffMin < 60) {
        return "Over " + diffMin + " min";
    }
    var hours = Math.floor(diffMin / 60);
    var mins = diffMin % 60;
    return "Over " + hours + "u " + mins + "m";
}

/* ==========================================================================
   UITKLAPPEN VAN TEKSTVELDEN & RENDEREN VAN DE TABEL
   ========================================================================== */

window.toggleExpandText = function(el, memKey) {
    if (!el) return;
    var isNowExpanded = el.classList.toggle('is-expanded');
    if (memKey) {
        expandedFieldMemory[memKey] = isNowExpanded;
    }
};

window.expandTextareaInput = function(el, memKey) {
    if (!el) return;
    el.classList.add('is-expanded');
    el.style.height = 'auto';
    el.style.height = Math.max(40, el.scrollHeight + 4) + 'px';
    if (memKey) {
        expandedFieldMemory[memKey] = true;
    }
};

window.collapseTextareaInput = function(el, memKey) {
    if (!el) return;
    el.classList.remove('is-expanded');
    el.style.height = '';
    if (memKey) {
        expandedFieldMemory[memKey] = false;
    }
};

window.renderAssignmentsList = function() {
    var container = document.getElementById('assignments-list-container');
    if (!container) return;

    var activeEl = document.activeElement;
    if (activeEl && activeEl.classList && activeEl.classList.contains('live-edit-field')) {
        return;
    }

    var searchEl = document.getElementById('assignment-search');
    var filterQuery = searchEl ? searchEl.value.toLowerCase().trim() : "";

    var sorted = getSortedAssignments().filter(function(item) {
        if (!filterQuery) return true;
        var haystack = [
            item.title || '',
            item.status || '',
            item.assignedTo || '',
            item.notes || '',
            item.feedback || ''
        ].join(' ').toLowerCase();
        return haystack.includes(filterQuery);
    });

    if (sorted.length === 0) {
        container.innerHTML = '<div class="empty-assignments-msg">Geen opdrachten gevonden. Gebruik Sync Jotihunt of klik op Nieuwe Opdracht.</div>';
        return;
    }

    var html = `
        <div class="assignments-grid-header">
            <div>Opdracht</div>
            <div>Status</div>
            <div>Deadline</div>
            <div>Opgepakt door</div>
            <div>Punten</div>
            <div>Feedback</div>
            <div>Opmerkingen / Notities</div>
        </div>
    `;

    var adminMode = (typeof isAdmin !== 'undefined' && isAdmin);
    var activeUserName = (typeof currentUserName !== 'undefined' && currentUserName) ? currentUserName : '';

    sorted.forEach(function(item) {
        var key = item.key;
        var status = item.status || 'Open';
        var statusClass = 'status-' + status.toLowerCase().replace(/[^a-z]/g, '');
        var remainingText = formatRemainingTime(item.deadlineTimestamp);
        var isUrgent = item.deadlineTimestamp && (item.deadlineTimestamp - Date.now() <= 600000) && (item.deadlineTimestamp - Date.now() > 0) && status !== 'Afgerond' && status !== 'Ingeleverd';

        var deadlineDisplay = item.deadlineTimestamp
            ? formatDeadlineDateAndTime(item.deadlineTimestamp, item.deadlineFormatted)
            : (item.deadlineFormatted || 'Geen datum');

        var assignedTo = item.assignedTo || '';
        var isAssignedToMe = activeUserName && assignedTo.toLowerCase() === activeUserName.toLowerCase();
        var claimBtnLabel = isAssignedToMe ? 'Loslaten' : 'Oppakken';

        var earnedVal = (item.earnedPoints !== undefined && item.earnedPoints !== null && item.earnedPoints !== '') ? item.earnedPoints : '-';
        var maxVal = (item.maxPoints !== undefined && item.maxPoints !== null && item.maxPoints !== '') ? item.maxPoints : '-';

        var titleExpanded = expandedFieldMemory[key + '_title'] ? 'is-expanded' : '';
        var assigneeExpanded = expandedFieldMemory[key + '_assignee'] ? 'is-expanded' : '';
        var fbExpanded = expandedFieldMemory[key + '_feedback'] ? 'is-expanded' : '';

        var pointsCellHtml = adminMode
            ? `<div class="points-edit-wrap">
                   <input type="number" class="live-edit-field points-input" value="${earnedVal !== '-' ? earnedVal : ''}" placeholder="-" onchange="updateAssignmentField('${key}', 'earnedPoints', this.value)" title="Behaalde punten">
                   <span>/</span>
                   <input type="number" class="live-edit-field points-input" value="${maxVal !== '-' ? maxVal : ''}" placeholder="Max" onchange="updateAssignmentField('${key}', 'maxPoints', this.value)" title="Max punten">
               </div>`
            : `<div class="points-display-badge">${earnedVal} / ${maxVal} pt</div>`;

        var feedbackHtml = adminMode
            ? `<textarea rows="1" class="live-edit-field table-text-input" placeholder="Geen feedback"
                   onfocus="expandTextareaInput(this, '${key}_feedback')"
                   oninput="expandTextareaInput(this, '${key}_feedback')"
                   onblur="collapseTextareaInput(this, '${key}_feedback')"
                   onchange="updateAssignmentField('${key}', 'feedback', this.value)">${escapeHtml(item.feedback || '')}</textarea>`
            : `<div class="feedback-text expandable-text ${fbExpanded}" onclick="toggleExpandText(this, '${key}_feedback')" title="Tik om volledig te lezen">${escapeHtml(item.feedback || 'Nog geen beoordeling')}</div>`;

        var adminRowActionsHtml = adminMode
            ? `<div class="row-admin-actions">
                   <button type="button" class="edit-assignment-btn" onclick="openEditAssignmentModal('${key}')" title="Opdrachtnaam en deadline bewerken">Bewerk</button>
                   <button type="button" class="delete-assignment-btn" onclick="deleteSingleAssignment('${key}')" title="Verwijder deze opdracht definitief">Wis</button>
               </div>`
            : '';

        html += `
            <div class="assignment-row ${statusClass} ${isUrgent ? 'row-urgent' : ''}">
                <!-- 1. Opdracht (Klik opent Jotihunt.nl opdracht of homepage, Admin kan naam bewerken) -->
                <div class="cell-block cell-title">
                    <span class="mobile-col-label">Opdracht</span>
                    <div class="title-row-wrap">
                        <a href="${escapeHtml(item.url || 'https://jotihunt.nl/')}" target="_blank" rel="noopener"
                           class="assignment-title-link expandable-text ${titleExpanded}"
                           onclick="event.stopPropagation();"
                           title="Klik om de opdracht op Jotihunt.nl te openen">${escapeHtml(item.title || 'Naamloze opdracht')}</a>
                        ${adminRowActionsHtml}
                    </div>
                </div>

                <!-- 2. Status -->
                <div class="cell-block cell-status">
                    <span class="mobile-col-label">Status</span>
                    <select class="status-select ${statusClass}" onchange="updateAssignmentField('${key}', 'status', this.value)">
                        <option value="Open" ${status === 'Open' ? 'selected' : ''}>Open</option>
                        <option value="Bezig" ${status === 'Bezig' ? 'selected' : ''}>Bezig</option>
                        <option value="Ingeleverd" ${status === 'Ingeleverd' ? 'selected' : ''}>Ingeleverd</option>
                        <option value="Deadline verlopen" ${status === 'Deadline verlopen' ? 'selected' : ''}>Deadline verlopen</option>
                        <option value="Afgerond" ${status === 'Afgerond' ? 'selected' : ''}>Afgerond</option>
                    </select>
                </div>

                <!-- 3. Deadline (Voor Admins direct klikbaar om datum & tijd te wijzigen) -->
                <div class="cell-block cell-deadline">
                    <span class="mobile-col-label">Deadline</span>
                    <div class="deadline-main ${adminMode ? 'admin-editable-deadline' : ''}"
                         ${adminMode ? `onclick="openEditAssignmentModal('${key}')" title="Klik om deadline en opdracht te bewerken"` : ''}>
                        ${escapeHtml(deadlineDisplay)}
                    </div>
                    <div class="deadline-sub ${isUrgent || status === 'Deadline verlopen' ? 'urgent-text' : ''}">${remainingText}</div>
                </div>

                <!-- 4. Opgepakt door -->
                <div class="cell-block cell-assignee">
                    <span class="mobile-col-label">Opgepakt door</span>
                    <div class="assignee-row">
                        <span class="assignee-name expandable-text ${assigneeExpanded}" onclick="toggleExpandText(this, '${key}_assignee')" title="Tik om volledig te lezen">${assignedTo ? escapeHtml(assignedTo) : 'Niemand'}</span>
                        <button type="button" class="claim-btn ${isAssignedToMe ? 'btn-release' : 'btn-claim'}" onclick="toggleClaimAssignment('${key}')">${claimBtnLabel}</button>
                    </div>
                </div>

                <!-- 5. Punten -->
                <div class="cell-block cell-points">
                    <span class="mobile-col-label">Punten</span>
                    ${pointsCellHtml}
                </div>

                <!-- 6. Feedback -->
                <div class="cell-block cell-feedback">
                    <span class="mobile-col-label">Feedback</span>
                    ${feedbackHtml}
                </div>

                <!-- 7. Opmerkingen / Notities -->
                <div class="cell-block cell-notes">
                    <span class="mobile-col-label">Opmerkingen / Notities</span>
                    <textarea rows="1" class="live-edit-field table-text-input" placeholder="Voeg notitie toe..."
                        onfocus="expandTextareaInput(this, '${key}_notes')"
                        oninput="expandTextareaInput(this, '${key}_notes')"
                        onblur="collapseTextareaInput(this, '${key}_notes')"
                        onchange="updateAssignmentField('${key}', 'notes', this.value)">${escapeHtml(item.notes || '')}</textarea>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
};

/* Eén-klik taak oppakken of loslaten:
   Zet de status ALLEEN op 'Bezig' als de opdracht op 'Open' stond! */
window.toggleClaimAssignment = function(key) {
    if (typeof currentUserName === 'undefined' || !currentUserName) {
        alert("Log eerst in met je naam om een opdracht op te pakken.");
        return;
    }
    var item = assignmentsData[key];
    if (!item) return;

    var currentAssignee = item.assignedTo || "";
    var isMe = currentAssignee.toLowerCase() === currentUserName.toLowerCase();

    var updates = {
        assignedTo: isMe ? "" : currentUserName,
        updatedAt: Date.now()
    };

    if (!isMe && (!item.status || item.status === 'Open')) {
        updates.status = 'Bezig';
    } else if (isMe && item.status === 'Bezig') {
        updates.status = 'Open';
    }

    db.ref('assignments/' + key).update(updates).then(function() {
        schedulePushAssignmentsToGoogleSheet();
    });
};

/* Sla wijzigingen in status, opmerkingen, punten of feedback direct op in Firebase én Google Sheets */
window.updateAssignmentField = function(key, field, value) {
    if (!key || !field) return;
    var item = assignmentsData[key] || {};
    var parsedVal = value;

    if (field === 'earnedPoints' || field === 'maxPoints') {
        parsedVal = value === '' ? null : Number(value);
    }

    var updates = { updatedAt: Date.now() };
    updates[field] = parsedVal;

    // Als iemand handmatig de status wijzigt in de dropdown, zet manualStatusOverride op true
    // zodat ook Telegram-opdrachten die op 'Afgerond' stonden vrij van status kunnen veranderen!
    if (field === 'status') {
        updates.manualStatusOverride = true;
    }

    // Als er nieuwe behaalde punten of feedback worden ingevuld, springt hij naar 'Afgerond'
    if (field === 'earnedPoints' && parsedVal !== null && !isNaN(parsedVal)) {
        updates.status = 'Afgerond';
        updates.manualStatusOverride = false;
    }
    if (field === 'feedback' && String(parsedVal || '').trim() !== '') {
        updates.status = 'Afgerond';
        updates.manualStatusOverride = false;
    }

    if (field === 'deadlineFormatted') {
        var newTs = parseSheetDeadline(parsedVal, item.createdAt || Date.now());
        if (newTs) {
            updates.deadlineTimestamp = newTs;
            updates.deadlineFormatted = formatDeadlineDateAndTime(newTs, parsedVal);
        }
    }

    db.ref('assignments/' + key).update(updates).then(function() {
        schedulePushAssignmentsToGoogleSheet();
    });
};

/* ==========================================================================
   MODAL VOOR TOEVOEGEN ÉN BEWERKEN VAN OPDRACHTNAAM + DEADLINE (DATUM & TIJD)
   ========================================================================== */

function ensureAssignmentModalInjected() {
    if (document.getElementById('assignment-modal-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'assignment-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div id="assignment-modal-box">
            <h3 id="assign-modal-header-title">Nieuwe Opdracht Toevoegen</h3>

            <div class="assign-field-group">
                <label for="assign-title-input">Titel van de opdracht:</label>
                <input type="text" id="assign-title-input" class="assign-modal-input" placeholder="Bijv: Bouw een katapult">
            </div>

            <div class="assign-field-group">
                <label for="assign-datetime-input">Deadline (Datum & Tijdstip):</label>
                <input type="datetime-local" id="assign-datetime-input" class="assign-modal-input" required>
            </div>

            <div class="assign-field-group">
                <label for="assign-maxpts-input">Maximaal te behalen punten:</label>
                <input type="number" id="assign-maxpts-input" class="assign-modal-input" value="5" min="0" max="100">
            </div>

            <div class="assign-field-group">
                <label for="assign-url-input">Specifieke Jotihunt-link (optioneel, standaard jotihunt.nl):</label>
                <input type="url" id="assign-url-input" class="assign-modal-input" placeholder="https://jotihunt.nl/">
            </div>

            <div class="assign-field-group">
                <label for="assign-notes-input">Opmerkingen / Wat willen we zien (optioneel):</label>
                <textarea id="assign-notes-input" class="assign-modal-input" rows="2" placeholder="Korte toelichting of eisen..."></textarea>
            </div>

            <div id="assign-modal-error"></div>

            <div class="assign-modal-actions">
                <button type="button" class="assign-modal-btn assign-btn-cancel" onclick="closeCustomAssignmentModal()">Annuleren</button>
                <button type="button" class="assign-modal-btn assign-btn-save" onclick="saveCustomAssignmentModal()">Opslaan</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
}

window.openCustomAssignmentModal = function() {
    if (typeof isAdmin === 'undefined' || !isAdmin) return;
    ensureAssignmentModalInjected();
    currentEditingAssignmentKey = null;

    document.getElementById('assign-modal-header-title').innerText = "Nieuwe Opdracht Toevoegen";
    var titleInput = document.getElementById('assign-title-input');
    var dtInput = document.getElementById('assign-datetime-input');
    var maxPtsInput = document.getElementById('assign-maxpts-input');
    var urlInput = document.getElementById('assign-url-input');
    var notesInput = document.getElementById('assign-notes-input');
    var errBox = document.getElementById('assign-modal-error');

    titleInput.value = "";
    maxPtsInput.value = "5";
    urlInput.value = "https://jotihunt.nl/";
    notesInput.value = "";
    errBox.style.display = "none";

    var defaultDeadline = new Date(Date.now() + 2 * 3600 * 1000);
    defaultDeadline.setMinutes(0, 0, 0);
    dtInput.value = toLocalDatetimeInputValue(defaultDeadline);

    document.getElementById('assignment-modal-overlay').style.display = 'flex';
    setTimeout(function() { titleInput.focus(); }, 50);
};

window.openEditAssignmentModal = function(key) {
    if (typeof isAdmin === 'undefined' || !isAdmin || !key) return;
    var item = assignmentsData[key];
    if (!item) return;

    ensureAssignmentModalInjected();
    currentEditingAssignmentKey = key;

    document.getElementById('assign-modal-header-title').innerText = "Opdracht & Deadline Bewerken";
    var titleInput = document.getElementById('assign-title-input');
    var dtInput = document.getElementById('assign-datetime-input');
    var maxPtsInput = document.getElementById('assign-maxpts-input');
    var urlInput = document.getElementById('assign-url-input');
    var notesInput = document.getElementById('assign-notes-input');
    var errBox = document.getElementById('assign-modal-error');

    titleInput.value = item.title || "";
    maxPtsInput.value = (item.maxPoints !== undefined && item.maxPoints !== null) ? item.maxPoints : "5";
    urlInput.value = item.url || "https://jotihunt.nl/";
    notesInput.value = item.notes || "";
    errBox.style.display = "none";

    var existingDate = item.deadlineTimestamp ? new Date(Number(item.deadlineTimestamp)) : new Date();
    if (isNaN(existingDate.getTime())) existingDate = new Date();
    dtInput.value = toLocalDatetimeInputValue(existingDate);

    document.getElementById('assignment-modal-overlay').style.display = 'flex';
    setTimeout(function() { titleInput.focus(); }, 50);
};

window.closeCustomAssignmentModal = function() {
    var overlay = document.getElementById('assignment-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    currentEditingAssignmentKey = null;
};

window.saveCustomAssignmentModal = function() {
    if (typeof isAdmin === 'undefined' || !isAdmin) return;

    var titleInput = document.getElementById('assign-title-input');
    var dtInput = document.getElementById('assign-datetime-input');
    var maxPtsInput = document.getElementById('assign-maxpts-input');
    var urlInput = document.getElementById('assign-url-input');
    var notesInput = document.getElementById('assign-notes-input');
    var errBox = document.getElementById('assign-modal-error');

    var title = titleInput.value.trim();
    if (!title) {
        errBox.innerText = "Voer een titel in voor de opdracht.";
        errBox.style.display = "block";
        return;
    }

    var dtVal = dtInput.value;
    var dlTs = null;
    if (dtVal) {
        var parsedDate = new Date(dtVal);
        if (!isNaN(parsedDate.getTime())) {
            dlTs = parsedDate.getTime();
        }
    }

    if (!dlTs) {
        errBox.innerText = "Kies een geldige datum en tijd via de datum/tijd-picker.";
        errBox.style.display = "block";
        return;
    }

    var now = Date.now();
    var dlFormatted = formatDeadlineDateAndTime(dlTs, "");
    var maxPts = maxPtsInput.value !== "" ? parseFloat(maxPtsInput.value) : 5;
    var customUrl = urlInput.value.trim() || "https://jotihunt.nl/";
    var notes = notesInput.value.trim();

    if (currentEditingAssignmentKey && assignmentsData[currentEditingAssignmentKey]) {
        // Bewerk bestaande opdracht
        var editKey = currentEditingAssignmentKey;
        var existingItem = assignmentsData[editKey];
        var updatedFields = {
            title: title,
            url: customUrl,
            deadlineTimestamp: dlTs,
            deadlineFormatted: dlFormatted,
            maxPoints: !isNaN(maxPts) ? maxPts : 5,
            notes: notes,
            updatedAt: now
        };

        // Als de deadline naar de toekomst is verplaatst en hij stond op 'Deadline verlopen', zet terug op 'Open'/'Bezig'
        if (dlTs > now && existingItem.status === 'Deadline verlopen') {
            updatedFields.status = existingItem.assignedTo ? 'Bezig' : 'Open';
        }

        db.ref('assignments/' + editKey).update(updatedFields).then(function() {
            closeCustomAssignmentModal();
            schedulePushAssignmentsToGoogleSheet(300);
        });
    } else {
        // Maak nieuwe opdracht aan
        var safeSlug = makeTitleSlug(title);
        var newId = "custom_" + (safeSlug || now);

        var unDelete = {};
        unDelete[newId] = null;
        if (safeSlug) unDelete['slug_' + safeSlug] = null;
        db.ref('deletedAssignments').update(unDelete);

        var newObj = {
            id: newId,
            title: title,
            url: customUrl,
            createdAt: now,
            status: "Open",
            manualStatusOverride: false,
            deadlineTimestamp: dlTs,
            deadlineFormatted: dlFormatted,
            assignedTo: "",
            earnedPoints: null,
            maxPoints: !isNaN(maxPts) ? maxPts : 5,
            feedback: "",
            notes: notes,
            updatedAt: now
        };
        newObj.status = computeDesiredStatus(newObj);

        db.ref('assignments/' + newId).set(newObj).then(function() {
            closeCustomAssignmentModal();
            schedulePushAssignmentsToGoogleSheet(300);
        });
    }
};

/* ==========================================================================
   10-MINUTEN DEADLINE MELDING MET 30 SEC WITTE VOORTGANGSBALK (+ 0.5S SLUITEN)
   ========================================================================== */

function showDeadlineAlertWithProgressBar(messageText) {
    var banner = document.getElementById('deadline-alert-banner');
    var textEl = document.getElementById('deadline-alert-text');
    if (!banner || !textEl) return;

    textEl.innerText = messageText;
    banner.style.position = 'relative';
    banner.style.overflow = 'hidden';
    banner.style.display = 'flex';

    // Maak of reset de witte voortgangsbalk onderaan de melding
    var barWrap = document.getElementById('deadline-alert-progress-wrap');
    if (!barWrap) {
        barWrap = document.createElement('div');
        barWrap.id = 'deadline-alert-progress-wrap';
        barWrap.className = 'toast-progress-wrap';
        barWrap.innerHTML = '<div id="deadline-alert-progress-bar" class="toast-progress-bar"></div>';
        banner.appendChild(barWrap);
    }

    var bar = document.getElementById('deadline-alert-progress-bar');
    if (bar) {
        bar.style.transition = 'none';
        bar.style.width = '0%';
        void bar.offsetWidth; // Forceer reflow
        bar.style.transition = 'width 6s linear'; // Veranderd van 30s naar 6s
        bar.style.width = '100%';
    }

    if (deadlineBannerTimer) clearTimeout(deadlineBannerTimer);
    if (deadlineBannerCloseTimeout) clearTimeout(deadlineBannerCloseTimeout);

    // Na 6 seconden heeft de witte balk de rechterkant bereikt -> wacht 0.5 sec (500ms) en sluit
    deadlineBannerTimer = setTimeout(function() {
        deadlineBannerCloseTimeout = setTimeout(function() {
            window.dismissDeadlineAlert();
        }, 500);
    }, 6000); // Veranderd van 30000 naar 6000
}

function checkAdminDeadlineNotifications() {
    if (typeof isAdmin === 'undefined' || !isAdmin) return;
    var now = Date.now();
    var tenMinutesMs = 10 * 60 * 1000;

    Object.keys(assignmentsData).forEach(function(key) {
        var item = assignmentsData[key];
        if (!item || !item.deadlineTimestamp || window.isAssignmentDeleted(key, item.title)) return;
        if (item.status === 'Ingeleverd' || item.status === 'Afgerond' || item.status === 'Deadline verlopen') return;

        var timeRemaining = Number(item.deadlineTimestamp) - now;
        if (timeRemaining > 0 && timeRemaining <= tenMinutesMs && !notifiedTenMinDeadlines[key]) {
            notifiedTenMinDeadlines[key] = true;
            var minsLeft = Math.max(1, Math.ceil(timeRemaining / 60000));
            showDeadlineAlertWithProgressBar(
                "Deadline melding: Opdracht '" + (item.title || "Onbekend") + "' verloopt over " + minsLeft + " minuten."
            );
        }
    });
}

window.dismissDeadlineAlert = function() {
    if (deadlineBannerTimer) clearTimeout(deadlineBannerTimer);
    if (deadlineBannerCloseTimeout) clearTimeout(deadlineBannerCloseTimeout);
    var banner = document.getElementById('deadline-alert-banner');
    if (banner) banner.style.display = 'none';
};

/* Start periodieke controles (elke 20s automatische status-check & UI-klok, elke 60s Google Sheet sync) */
setInterval(function() {
    enforceAutomaticAssignmentStatuses();
    checkAdminDeadlineNotifications();
    renderAssignmentsList();
}, 20000);

setInterval(function() {
    if (typeof isAdmin !== 'undefined' && isAdmin) {
        window.syncAssignmentsFromGoogleSheet(false);
    }
}, 60000);

setTimeout(function() {
    window.syncAssignmentsFromGoogleSheet(false);
}, 2500);

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ==========================================================================
   PERIODICKE OPRUIMING DELETED ASSIGNMENTS (Elke 5 minuten)
   Verwijdert items uit de prullenbak die ouder zijn dan 2 uur.
   ========================================================================== */
setInterval(function() {
    // Alleen uitvoeren als de gebruiker ingelogd is als Admin
    if (typeof isAdmin === 'undefined' || !isAdmin) return;
    
    db.ref('deletedAssignments').once('value', function(snapshot) {
        var data = snapshot.val();
        if (!data) return;

        var now = Date.now();
        var maxAgeMs = 2 * 3600 * 1000; // 2 uur oud
        var updates = {};
        var hasExpired = false;

        Object.keys(data).forEach(function(key) {
            var timestamp = Number(data[key]);
            if (!isNaN(timestamp) && (now - timestamp > maxAgeMs)) {
                updates[key] = null; // null verwijdert de sleutel uit Firebase Realtime Database
                hasExpired = true;
            }
        });

        if (hasExpired) {
            db.ref('deletedAssignments').update(updates);
        }
    });
}, 5 * 60 * 1000); // 5 minuten in milliseconden