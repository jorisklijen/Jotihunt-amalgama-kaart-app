/* ==========================================================================
   4. ASSIGNMENTS.JS - OPDRACHTEN TRACKER (REALTIME SYNC, DEADLINES & PUNTEN)
   Vervanger van de Google Sheets tracker, geoptimaliseerd voor mobiel gebruik.
   Geen emoji's in de UI of knoppen.
   ========================================================================== */

var assignmentsData = {};
var notifiedTenMinDeadlines = {};

/* Luister realtime naar alle opdrachten in Firebase */
db.ref('assignments').on('value', function(snapshot) {
    assignmentsData = snapshot.val() || {};
    updatePointsSummary();
    renderAssignmentsList();
    checkAdminDeadlineNotifications();
});

/* Luister naar binnenkomende Telegram beoordelingen en koppel ze automatisch aan de juiste opdracht */
db.ref('telegramData/assignments').on('value', function(snapshot) {
    if (!isAdmin) return; // Alleen een ingelogde Admin verwerkt de koppeling om dubbele writes te voorkomen
    var tgItems = snapshot.val();
    if (!tgItems) return;

    Object.keys(tgItems).forEach(function(tgKey) {
        var tg = tgItems[tgKey];
        if (!tg || tg.linkedToAssignment || !tg.title) return;

        var cleanTgTitle = tg.title.toLowerCase().trim();
        var matchedId = Object.keys(assignmentsData).find(function(id) {
            var aTitle = String(assignmentsData[id].title || '').toLowerCase().trim();
            return aTitle && (aTitle.includes(cleanTgTitle) || cleanTgTitle.includes(aTitle));
        });

        if (matchedId) {
            db.ref('assignments/' + matchedId).update({
                earnedPoints: tg.points !== undefined ? tg.points : null,
                feedback: tg.feedback || tg.rawMessage || "Beoordeeld via Telegram",
                status: "Afgerond",
                updatedAt: Date.now()
            });
            db.ref('telegramData/assignments/' + tgKey).update({ linkedToAssignment: matchedId });
        } else {
            // Maak opdracht automatisch aan als deze alleen via Telegram binnenkwam
            var newId = 'tg_' + tgKey.replace(/[^a-zA-Z0-9_-]/g, '');
            db.ref('assignments/' + newId).set({
                id: newId,
                title: tg.title,
                deadlineTimestamp: tg.timestamp || Date.now(),
                deadlineFormatted: tg.timeFormatted || "Beoordeeld",
                maxPoints: tg.maxPoints || Math.max(0, tg.points || 0),
                earnedPoints: tg.points || 0,
                feedback: tg.feedback || tg.rawMessage || "",
                status: "Afgerond",
                assignedTo: "",
                notes: "Automatisch aangemaakt vanuit Telegram",
                updatedAt: Date.now()
            });
            db.ref('telegramData/assignments/' + tgKey).update({ linkedToAssignment: newId });
        }
    });
});

/* Bereken totaaloverzicht van behaalde en maximaal te behalen punten */
function updatePointsSummary() {
    var totalEarned = 0;
    var totalMax = 0;
    var activeCount = 0;

    Object.keys(assignmentsData).forEach(function(key) {
        var item = assignmentsData[key];
        if (!item) return;

        var maxP = parseFloat(item.maxPoints);
        if (!isNaN(maxP) && maxP > 0) totalMax += maxP;

        var earnedP = parseFloat(item.earnedPoints);
        if (!isNaN(earnedP)) totalEarned += earnedP;

        if (item.status !== 'Afgerond' && item.status !== 'Ingeleverd') {
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

/* Sorteer opdrachten zodat de dichtstbijzijnde actieve deadline altijd bovenaan staat */
function getSortedAssignments() {
    var now = Date.now();
    var list = Object.keys(assignmentsData).map(function(k) {
        var obj = Object.assign({}, assignmentsData[k]);
        obj.key = k;
        return obj;
    });

    list.sort(function(a, b) {
        var aDone = (a.status === 'Afgerond' || a.status === 'Ingeleverd');
        var bDone = (b.status === 'Afgerond' || b.status === 'Ingeleverd');

        // Actieve opdrachten altijd boven al ingeleverde/afgeronde opdrachten
        if (aDone !== bDone) return aDone ? 1 : -1;

        var tA = a.deadlineTimestamp ? Number(a.deadlineTimestamp) : Infinity;
        var tB = b.deadlineTimestamp ? Number(b.deadlineTimestamp) : Infinity;

        var aFuture = tA >= (now - 600000); // Tot 10 min na deadline nog hoog houden
        var bFuture = tB >= (now - 600000);

        if (aFuture && bFuture) {
            return tA - tB; // Dichtstbijzijnde deadline eerst
        }
        if (aFuture !== bFuture) {
            return aFuture ? -1 : 1; // Toekomstige deadlines boven verlopen deadlines
        }
        return tB - tA;
    });

    return list;
}

function formatRemainingTime(deadlineMs) {
    if (!deadlineMs || isNaN(deadlineMs)) return "Geen deadline";
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

/* Render de responsieve opdrachtenlijst */
window.renderAssignmentsList = function() {
    var container = document.getElementById('assignments-list-container');
    if (!container) return;

    // Niet opnieuw opbouwen als de gebruiker net een opmerking of puntenveld typt
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
        container.innerHTML = '<div class="empty-assignments-msg">Geen opdrachten gevonden. Gebruik Sync Jotihunt of voeg een opdracht toe.</div>';
        return;
    }

    var html = `
        <div class="assignments-grid-header">
            <div>Opdracht</div>
            <div>Status</div>
            <div>Deadline</div>
            <div>Opgepakt door</div>
            <div>Punten</div>
            <div>Feedback (Telegram)</div>
            <div>Opmerkingen / Notities</div>
        </div>
    `;

    sorted.forEach(function(item) {
        var key = item.key;
        var status = item.status || 'Open';
        var statusClass = 'status-' + status.toLowerCase().replace(/[^a-z]/g, '');
        var remainingText = formatRemainingTime(item.deadlineTimestamp);
        var isUrgent = item.deadlineTimestamp && (item.deadlineTimestamp - Date.now() <= 600000) && (item.deadlineTimestamp - Date.now() > 0) && status !== 'Afgerond' && status !== 'Ingeleverd';

        var assignedTo = item.assignedTo || '';
        var isAssignedToMe = currentUserName && assignedTo.toLowerCase() === currentUserName.toLowerCase();
        var claimBtnLabel = isAssignedToMe ? 'Loslaten' : 'Oppakken';

        var earnedVal = (item.earnedPoints !== undefined && item.earnedPoints !== null && item.earnedPoints !== '') ? item.earnedPoints : '-';
        var maxVal = (item.maxPoints !== undefined && item.maxPoints !== null && item.maxPoints !== '') ? item.maxPoints : '-';

        var pointsCellHtml = isAdmin
            ? `<div class="points-edit-wrap">
                   <input type="number" class="live-edit-field points-input" value="${earnedVal !== '-' ? earnedVal : ''}" placeholder="-" onchange="updateAssignmentField('${key}', 'earnedPoints', this.value)" title="Behaalde punten">
                   <span>/</span>
                   <input type="number" class="live-edit-field points-input" value="${maxVal !== '-' ? maxVal : ''}" placeholder="Max" onchange="updateAssignmentField('${key}', 'maxPoints', this.value)" title="Max punten">
               </div>`
            : `<div class="points-display-badge">${earnedVal} / ${maxVal} pt</div>`;

        var feedbackHtml = isAdmin
            ? `<input type="text" class="live-edit-field table-text-input" value="${escapeHtml(item.feedback || '')}" placeholder="Geen feedback" onchange="updateAssignmentField('${key}', 'feedback', this.value)">`
            : `<div class="feedback-text">${escapeHtml(item.feedback || 'Nog geen beoordeling')}</div>`;

        html += `
            <div class="assignment-row ${statusClass} ${isUrgent ? 'row-urgent' : ''}">
                <!-- 1. Titel / Opdracht -->
                <div class="cell-block cell-title">
                    <span class="mobile-col-label">Opdracht</span>
                    <div class="assignment-title-text">${escapeHtml(item.title || 'Naamloze opdracht')}</div>
                    ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" class="assignment-link">Bekijk op Jotihunt.nl</a>` : ''}
                </div>

                <!-- 2. Status -->
                <div class="cell-block cell-status">
                    <span class="mobile-col-label">Status</span>
                    <select class="status-select ${statusClass}" onchange="updateAssignmentField('${key}', 'status', this.value)">
                        <option value="Open" ${status === 'Open' ? 'selected' : ''}>Open</option>
                        <option value="Bezig" ${status === 'Bezig' ? 'selected' : ''}>Bezig</option>
                        <option value="Ingeleverd" ${status === 'Ingeleverd' ? 'selected' : ''}>Ingeleverd</option>
                        <option value="Afgerond" ${status === 'Afgerond' ? 'selected' : ''}>Afgerond</option>
                    </select>
                </div>

                <!-- 3. Deadline -->
                <div class="cell-block cell-deadline">
                    <span class="mobile-col-label">Deadline</span>
                    <div class="deadline-main">${escapeHtml(item.deadlineFormatted || 'Geen datum')}</div>
                    <div class="deadline-sub ${isUrgent ? 'urgent-text' : ''}">${remainingText}</div>
                </div>

                <!-- 4. Opgepakt door -->
                <div class="cell-block cell-assignee">
                    <span class="mobile-col-label">Opgepakt door</span>
                    <div class="assignee-row">
                        <span class="assignee-name">${assignedTo ? escapeHtml(assignedTo) : 'Niemand'}</span>
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
                    <span class="mobile-col-label">Opmerkingen</span>
                    <input type="text" class="live-edit-field table-text-input" value="${escapeHtml(item.notes || '')}" placeholder="Voeg notitie toe..." onchange="updateAssignmentField('${key}', 'notes', this.value)">
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
};

/* Eén-klik taak oppakken of loslaten voor ingelogde Hunter of Admin */
window.toggleClaimAssignment = function(key) {
    if (!currentUserName) {
        alert("Log eerst in om een opdracht op te pakken.");
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

    // Zet status automatisch op 'Bezig' zodra iemand een Open opdracht oppakt
    if (!isMe && (!item.status || item.status === 'Open')) {
        updates.status = 'Bezig';
    }

    db.ref('assignments/' + key).update(updates);
};

/* Sla wijzigingen in status, opmerkingen, punten of feedback direct op in Firebase */
window.updateAssignmentField = function(key, field, value) {
    if (!key || !field) return;
    var parsedVal = value;
    if (field === 'earnedPoints' || field === 'maxPoints') {
        parsedVal = value === '' ? null : Number(value);
    }
    var updates = { updatedAt: Date.now() };
    updates[field] = parsedVal;
    db.ref('assignments/' + key).update(updates);
};

/* Neutrale 10-minuten deadline notificatie voor Admins */
function checkAdminDeadlineNotifications() {
    if (!isAdmin) return;
    var now = Date.now();
    var tenMinutesMs = 10 * 60 * 1000;

    Object.keys(assignmentsData).forEach(function(key) {
        var item = assignmentsData[key];
        if (!item || !item.deadlineTimestamp) return;
        if (item.status === 'Ingeleverd' || item.status === 'Afgerond') return;

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

setInterval(function() {
    checkAdminDeadlineNotifications();
    renderAssignmentsList();
}, 20000);

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}