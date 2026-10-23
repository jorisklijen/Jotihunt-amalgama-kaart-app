/* ==========================================================================
   4. ASSIGNMENTS.JS - OPDRACHTEN TRACKER + TWEE-WEG GOOGLE SHEETS SYNC
   - Verwijderen van opdrachten zonder dat ze terugkomen (via deletedAssignments)
   - Sortering: Open -> Bezig -> Deadline verlopen -> Ingeleverd -> Afgerond
   - Handmatige invoer via RD-stijl Modal met datetime-local picker
   - Klik op opdrachtnaam opent specifieke Jotihunt-pagina of https://jotihunt.nl/
   ========================================================================== */

var assignmentsData = {};
var deletedAssignmentsMap = {};
var notifiedTenMinDeadlines = {};
var expandedFieldMemory = {};
var sheetWriteDebounceTimer = null;
var isPushingToSheet = false;

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

/* Luister naar verwijderde opdrachten zodat deze nooit meer ongewenst terugkomen */
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

/* Luister naar binnenkomende Telegram beoordelingen en koppel ze direct aan Firebase én Google Sheets */
db.ref('telegramData/assignments').on('value', function(snapshot) {
    var tgItems = snapshot.val();
    if (!tgItems) return;

    var updatesPromiseList = [];

    Object.keys(tgItems).forEach(function(tgKey) {
        var tg = tgItems[tgKey];
        if (!tg || tg.linkedToAssignment || !tg.title) return;

        // Als deze opdracht eerder handmatig is verwijderd, negeer hem dan
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
                assignedTo: "",
                notes: "Automatisch aangemaakt vanuit Telegram",
                syncedToSheet: true,
                updatedAt: Date.now()
            };
            var p3 = db.ref('assignments/' + newId).set(newAssignmentObj);
            var p4 = db.ref('telegramData/assignments/' + tgKey).update({ linkedToAssignment: newId });
            updatesPromiseList.push(p3, p4);
        }
    });

    if (updatesPromiseList.length > 0) {
        Promise.all(updatesPromiseList).then(function() {
            schedulePushAssignmentsToGoogleSheet(300);
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

/* Formatteer een timestamp altijd als "DD-MM HH:MM" zodat er altijd een datum bij de tijd staat */
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

        // Als de opdracht bijv. om 22:00 binnenkomt en de deadline is 01:00, tel 1 dag op
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
   AUTOMATISCHE STATUS-REGELS:
   1. Punten en/of feedback aanwezig -> Status altijd op 'Afgerond'
   2. Deadline verlopen en NIET op 'Ingeleverd' of 'Afgerond' -> Status op 'Deadline verlopen'
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

    if (hasPointsOrFeedback(item)) {
        return 'Afgerond';
    }

    if (item.deadlineTimestamp && !isNaN(item.deadlineTimestamp)) {
        var isPast = Number(item.deadlineTimestamp) < Date.now();
        if (isPast && currentStatus !== 'Ingeleverd' && currentStatus !== 'Afgerond') {
            return 'Deadline verlopen';
        }
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

        // Verwijder direct als hij op de blokkeerlijst staat
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
   GOOGLE SHEETS TWEE-WEG SYNCHRONISATIE (LEZEN, SCHRIJVEN ÉN VERWIJDEREN)
   ========================================================================== */

window.pushAssignmentsToGoogleSheet = async function() {
    if (!GOOGLE_SHEET_WEBAPP_URL) return;
    isPushingToSheet = true;

    var sorted = getSortedAssignments();
    var flagUpdates = {};

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

        if (!item.syncedToSheet && item.key) {
            flagUpdates[item.key + '/syncedToSheet'] = true;
        }

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

    try {
        await fetch(GOOGLE_SHEET_WEBAPP_URL, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ rows: rowsPayload })
        });
        if (Object.keys(flagUpdates).length > 0) {
            db.ref('assignments').update(flagUpdates);
        }
    } catch (err) {
        console.warn("Kon niet naar Google Sheet schrijven:", err);
    } finally {
        setTimeout(function() { isPushingToSheet = false; }, 1500);
    }
};

function schedulePushAssignmentsToGoogleSheet(delayMs) {
    if (sheetWriteDebounceTimer) clearTimeout(sheetWriteDebounceTimer);
    sheetWriteDebounceTimer = setTimeout(function() {
        window.pushAssignmentsToGoogleSheet();
    }, delayMs || 800);
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

/* Haal de Google Sheet CSV op en synchroniseer (inclusief detectie van in de Sheet verwijderde rijen) */
window.syncAssignmentsFromGoogleSheet = async function(showFeedback) {
    if (isPushingToSheet) return;

    var csvText = null;
    var targetUrl = GOOGLE_SHEET_CSV_URL + "&t=" + Date.now();

    try {
        var res = await fetch(targetUrl, { cache: "no-store" });
        if (res.ok) {
            csvText = await res.text();
        }
    } catch (e) {}

    if (!csvText) {
        try {
            var proxyUrl = "https://jotihunt-proxy.joriskleijn2000.workers.dev/?url=" + encodeURIComponent(targetUrl);
            var proxyRes = await fetch(proxyUrl, { cache: "no-store" });
            if (proxyRes.ok) {
                csvText = await proxyRes.text();
            }
        } catch (proxyErr) {
            console.warn("Kon Google Sheet niet ophalen:", proxyErr);
        }
    }

    if (!csvText || csvText.trim().startsWith("<!DOCTYPE html>")) {
        if (showFeedback) alert("Kon de Google Sheet niet uitlezen. Controleer of het bestand openbaar staat ingesteld.");
        return;
    }

    var rows = parseCSVToRows(csvText);
    var headers = rows.length > 0 ? rows[0].map(function(h) { return String(h || '').toLowerCase().trim(); }) : [];

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
    var deletedBatch = {};
    var seenKeysInSheet = {};
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

        // Als deze opdracht in de app is verwijderd, negeer hem dan uit de gecachete CSV
        if (window.isAssignmentDeleted(targetKey, title)) {
            continue;
        }

        seenKeysInSheet[targetKey] = true;
        var existingObj = assignmentsData[targetKey] || {};

        // Als de opdracht korter dan 20 seconden geleden in de app is aangepast, laat de app-data voorrang houden op de CSV-cache
        if (existingObj.updatedAt && (Date.now() - existingObj.updatedAt < 20000)) {
            continue;
        }

        var rawStatus = row[colStatus] !== undefined ? row[colStatus] : "";
        var rawDeadline = row[colDeadline] !== undefined ? row[colDeadline] : "";
        var rawAssignee = row[colAssignee] !== undefined ? String(row[colAssignee]).trim() : "";
        var rawFeedback = row[colFeedback] !== undefined ? String(row[colFeedback]).trim() : "";
        var rawNotes = row[colNotes] !== undefined ? String(row[colNotes]).trim() : "";

        if (rawAssignee.length > 35 || rawAssignee.toLowerCase().startsWith("wat willen we zien")) {
            if (!rawNotes) {
                rawNotes = rawAssignee;
            }
            rawAssignee = existingObj.assignedTo && existingObj.assignedTo.length <= 35 ? existingObj.assignedTo : "";
        }

        var earnedPoints = existingObj.earnedPoints !== undefined ? existingObj.earnedPoints : null;
        var maxPoints = existingObj.maxPoints !== undefined ? existingObj.maxPoints : null;

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
                if (colEarned === colMax && existingObj.earnedPoints === undefined) {
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

        var createdAtMs = existingObj.createdAt || Date.now();
        var parsedDeadlineTs = parseSheetDeadline(rawDeadline, createdAtMs) || existingObj.deadlineTimestamp || null;
        var formattedDeadline = parsedDeadlineTs
            ? formatDeadlineDateAndTime(parsedDeadlineTs, rawDeadline)
            : (rawDeadline || existingObj.deadlineFormatted || "Geen datum");

        var mergedItem = {
            id: targetKey,
            title: title,
            url: existingObj.url || "https://jotihunt.nl/",
            createdAt: createdAtMs,
            status: rawStatus ? normalizeSheetStatus(rawStatus) : (existingObj.status || "Open"),
            deadlineFormatted: formattedDeadline,
            deadlineTimestamp: parsedDeadlineTs,
            assignedTo: rawAssignee !== "" ? rawAssignee : "",
            earnedPoints: earnedPoints,
            maxPoints: maxPoints,
            feedback: rawFeedback !== "" ? rawFeedback : (existingObj.feedback || ""),
            notes: rawNotes !== "" ? rawNotes : (existingObj.notes || ""),
            syncedToSheet: true,
            updatedAt: existingObj.updatedAt || Date.now()
        };

        mergedItem.status = computeDesiredStatus(mergedItem);
        updatesBatch[targetKey] = mergedItem;
        syncedCount++;
    }

    // Detecteer opdrachten die eerder in de Sheet stonden (syncedToSheet === true), maar nu in de Sheet zijn verwijderd
    Object.keys(assignmentsData).forEach(function(k) {
        var item = assignmentsData[k];
        if (!item) return;
        var isRecentlyCreated = item.createdAt && (Date.now() - item.createdAt < 45000);
        if (item.syncedToSheet && !seenKeysInSheet[k] && !isRecentlyCreated) {
            updatesBatch[k] = null;
            deletedBatch[k] = Date.now();
            var slug = makeTitleSlug(item.title);
            if (slug) deletedBatch['slug_' + slug] = Date.now();
        }
    });

    if (Object.keys(deletedBatch).length > 0) {
        await db.ref('deletedAssignments').update(deletedBatch);
    }

    if (Object.keys(updatesBatch).length > 0) {
        await db.ref('assignments').update(updatesBatch);
    }

    schedulePushAssignmentsToGoogleSheet(500);
    if (showFeedback) {
        alert("Synchronisatie voltooid (" + syncedCount + " actieve opdrachten).");
    }
};

/* Koppel de "Sync Jotihunt" knop zodat deze zowel Jotihunt.nl als de Google Sheet synchroniseert */
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

    // 1. Zet op de verwijderde lijst zodat API en CSV-cache hem nooit terugplaatsen
    db.ref('deletedAssignments').update(delUpdates).then(function() {
        // 2. Verwijder direct uit Firebase en lokale state
        delete assignmentsData[key];
        return db.ref('assignments/' + key).remove();
    }).then(function() {
        // 3. Schrijf de opgeschoonde lijst direct naar de Google Sheet
        window.pushAssignmentsToGoogleSheet();
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
   1. Open (bovenaan)
   2. Bezig
   3. Deadline verlopen
   4. Ingeleverd
   5. Afgerond (altijd helemaal onderaan)
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

        // Sorteer eerst strikt op de gevraagde status-volgorde
        if (rankA !== rankB) {
            return rankA - rankB;
        }

        // Binnen dezelfde status: dichtstbijzijnde deadline altijd bovenaan
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
   OPDRACHT OPENEN OP JOTIHUNT.NL + UITKLAPPEN VAN TEKSTVELDEN
   ========================================================================== */

window.openAssignmentOnJotihunt = function(key) {
    var item = assignmentsData[key];
    var targetUrl = "https://jotihunt.nl/";
    if (item && item.url && String(item.url).trim().startsWith("http")) {
        targetUrl = String(item.url).trim();
    }
    window.open(targetUrl, '_blank', 'noopener');
};

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

/* Render de responsieve opdrachtenlijst (Google Sheets tabel op desktop, kaarten op mobiel) */
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

        var deleteBtnHtml = adminMode
            ? `<button type="button" class="delete-assignment-btn" onclick="deleteSingleAssignment('${key}')" title="Verwijder deze opdracht definitief">Wis</button>`
            : '';

        html += `
            <div class="assignment-row ${statusClass} ${isUrgent ? 'row-urgent' : ''}">
                <!-- 1. Opdracht (Klik opent Jotihunt.nl opdracht of homepage) -->
                <div class="cell-block cell-title">
                    <span class="mobile-col-label">Opdracht</span>
                    <div class="title-row-wrap">
                        <a href="${escapeHtml(item.url || 'https://jotihunt.nl/')}" target="_blank" rel="noopener"
                           class="assignment-title-link expandable-text ${titleExpanded}"
                           onclick="event.stopPropagation();"
                           title="Klik om de opdracht op Jotihunt.nl te openen">${escapeHtml(item.title || 'Naamloze opdracht')}</a>
                        ${deleteBtnHtml}
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

                <!-- 3. Deadline (Altijd met Datum + Tijd) -->
                <div class="cell-block cell-deadline">
                    <span class="mobile-col-label">Deadline</span>
                    <div class="deadline-main">${escapeHtml(deadlineDisplay)}</div>
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

    // Zet alleen op 'Bezig' als iemand de opdracht oppakt én de status op 'Open' stond
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

    // Als er behaalde punten of feedback wordt ingevuld, zet de status automatisch op 'Afgerond'
    if (field === 'earnedPoints' && parsedVal !== null && !isNaN(parsedVal)) {
        updates.status = 'Afgerond';
    }
    if (field === 'feedback' && String(parsedVal || '').trim() !== '') {
        updates.status = 'Afgerond';
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
   SOEPELE MODAL VOOR NIEUWE OPDRACHT TOEVOEGEN (ZELFDE STIJL ALS + RD MODAL)
   ========================================================================== */

function ensureAssignmentModalInjected() {
    if (document.getElementById('assignment-modal-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'assignment-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div id="assignment-modal-box">
            <h3>Nieuwe Opdracht Toevoegen</h3>

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

    // Standaard deadline op +2 uur vanaf nu zetten voor snelle invoer
    var defaultDeadline = new Date(Date.now() + 2 * 3600 * 1000);
    defaultDeadline.setMinutes(0, 0, 0);
    dtInput.value = toLocalDatetimeInputValue(defaultDeadline);

    document.getElementById('assignment-modal-overlay').style.display = 'flex';
    setTimeout(function() { titleInput.focus(); }, 50);
};

window.closeCustomAssignmentModal = function() {
    var overlay = document.getElementById('assignment-modal-overlay');
    if (overlay) overlay.style.display = 'none';
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

    var safeSlug = makeTitleSlug(title);
    var newId = "custom_" + (safeSlug || now);

    // Mocht deze titel eerder verwijderd zijn, haal hem dan van de blokkeerlijst omdat hij nu bewust nieuw wordt aangemaakt
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
        deadlineTimestamp: dlTs,
        deadlineFormatted: dlFormatted,
        assignedTo: "",
        earnedPoints: null,
        maxPoints: !isNaN(maxPts) ? maxPts : 5,
        feedback: "",
        notes: notes,
        syncedToSheet: true,
        updatedAt: now
    };
    newObj.status = computeDesiredStatus(newObj);

    db.ref('assignments/' + newId).set(newObj).then(function() {
        closeCustomAssignmentModal();
        schedulePushAssignmentsToGoogleSheet(300);
    });
};

/* Neutrale 10-minuten deadline notificatie voor Admins */
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
            var banner = document.getElementById('deadline-alert-banner');
            var textEl = document.getElementById('deadline-alert-text');
            if (banner && textEl) {
                textEl.innerText = "Deadline melding: Opdracht '" + (item.title || "Onbekend") + "' verloopt over " + minsLeft + " minuten.";
                banner.style.display = 'flex';
            }
        }
    });
}

window.dismissDeadlineAlert = function() {
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