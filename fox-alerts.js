/* ==========================================================================
   3B. FOX-ALERTS.JS - VOSSEN STATUS MENU, GROENE MELDING & TEGENHUNT POPUP
   ========================================================================== */

var selectedFoxInfoArea = null;
var singleClickFoxTimerByArea = {};
var lastFoxTapTimeByArea = {};
var MAX_STATUS_TIMER_SECONDS = 12 * 3600; // Maximaal 12 uur tellen

function injectFoxStatusPanel() {
    var mapWrapper = document.getElementById('map-wrapper');
    if (!mapWrapper || document.getElementById('fox-status-panel')) return;

    var panel = document.createElement('div');
    panel.id = 'fox-status-panel';
    panel.innerHTML = `
        <div id="fox-status-header">
            <span>Vossen Status</span>
            <button type="button" id="fox-status-min-btn" title="Minimaliseren / Maximaliseren">-</button>
        </div>
        <div id="fox-status-body">
            <div id="fox-status-buttons-list"></div>
        </div>
    `;
    mapWrapper.appendChild(panel);

    var detailCard = document.createElement('div');
    detailCard.id = 'fox-fixed-detail-card';
    detailCard.style.display = 'none';
    detailCard.innerHTML = `
        <div id="fox-detail-header">
            <div style="display:flex; align-items:center; gap:7px;">
                <span id="fox-detail-color-dot"></span>
                <span id="fox-detail-title">Deelgebied</span>
            </div>
            <button type="button" id="fox-detail-close-btn" title="Sluiten">✕</button>
        </div>
        <div id="fox-detail-body">
            <div class="fox-info-row">
                <span class="fox-info-label" id="fox-detail-status-label">Op status:</span>
                <span class="fox-info-val" id="fox-detail-timer-val" data-updated-at="">--</span>
            </div>
            <div class="fox-info-row">
                <span class="fox-info-label">Jouw afstand & reistijd:</span>
                <span class="fox-info-val" id="fox-detail-my-travel">--</span>
            </div>
            <div class="fox-info-row">
                <span class="fox-info-label">Dichtstbijzijnde hunter:</span>
                <span class="fox-info-val" id="fox-detail-closest-hunter">--</span>
            </div>
            <div class="fox-detail-actions">
                <button type="button" id="fox-detail-zoom-btn" class="fox-info-zoom-btn">
                    Zoom op kaart
                </button>
                <button type="button" id="fox-detail-nav-btn" class="fox-info-nav-btn" style="display:none;">
                    Navigeer naar schatting
                </button>
            </div>
        </div>
    `;
    mapWrapper.appendChild(detailCard);

    if (typeof L !== 'undefined' && L.DomEvent) {
        L.DomEvent.disableClickPropagation(panel);
        L.DomEvent.disableScrollPropagation(panel);
        L.DomEvent.disableClickPropagation(detailCard);
        L.DomEvent.disableScrollPropagation(detailCard);
    }

    document.getElementById('fox-detail-close-btn').addEventListener('click', function() {
        selectedFoxInfoArea = null;
        window.renderFoxStatusButtons();
    });

    var minBtn = document.getElementById('fox-status-min-btn');
    var bodyEl = document.getElementById('fox-status-body');
    minBtn.addEventListener('click', function() {
        if (bodyEl.style.display === 'none') {
            bodyEl.style.display = 'flex';
            minBtn.innerText = '-';
        } else {
            bodyEl.style.display = 'none';
            minBtn.innerText = '+';
        }
    });

    var headerEl = document.getElementById('fox-status-header');
    var isDraggingFoxPanel = false, dragStartX = 0, dragStartY = 0;

    headerEl.addEventListener('mousedown', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        isDraggingFoxPanel = true;
        dragStartX = e.clientX - panel.offsetLeft;
        dragStartY = e.clientY - panel.offsetTop;
        document.addEventListener('mousemove', onFoxMouseMove);
        document.addEventListener('mouseup', onFoxMouseUp);
    });

    headerEl.addEventListener('touchstart', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        isDraggingFoxPanel = true;
        var touch = e.touches[0];
        dragStartX = touch.clientX - panel.offsetLeft;
        dragStartY = touch.clientY - panel.offsetTop;
        document.addEventListener('touchmove', onFoxTouchMove, { passive: false });
        document.addEventListener('touchend', onFoxTouchEnd);
    });

    function moveFoxPanel(clientX, clientY) {
        var maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
        var maxY = Math.max(0, mapWrapper.clientHeight - panel.offsetHeight);
        var newX = Math.max(0, Math.min(clientX - dragStartX, maxX));
        var newY = Math.max(0, Math.min(clientY - dragStartY, maxY));
        panel.style.left = newX + 'px';
        panel.style.top = newY + 'px';
        panel.style.right = 'auto';
        positionFoxDetailCard();
    }

    function onFoxMouseMove(e) {
        if (isDraggingFoxPanel) moveFoxPanel(e.clientX, e.clientY);
    }
    function onFoxTouchMove(e) {
        if (isDraggingFoxPanel) {
            e.preventDefault();
            moveFoxPanel(e.touches[0].clientX, e.touches[0].clientY);
        }
    }
    function onFoxMouseUp() {
        isDraggingFoxPanel = false;
        document.removeEventListener('mousemove', onFoxMouseMove);
        document.removeEventListener('mouseup', onFoxMouseUp);
    }
    function onFoxTouchEnd() {
        isDraggingFoxPanel = false;
        document.removeEventListener('touchmove', onFoxTouchMove);
        document.removeEventListener('touchend', onFoxTouchEnd);
    }

    window.addEventListener('resize', positionFoxDetailCard);
    window.renderFoxStatusButtons();
}

function positionFoxDetailCard() {
    var panel = document.getElementById('fox-status-panel');
    var card = document.getElementById('fox-fixed-detail-card');
    if (!panel || !card || card.style.display === 'none') return;

    var panelRect = panel.getBoundingClientRect();
    var wrapperEl = document.getElementById('map-wrapper');
    var wrapRect = wrapperEl ? wrapperEl.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

    var cardWidth = 235;
    var leftCandidate = (panelRect.left - wrapRect.left) - cardWidth - 8;
    var rightCandidate = (panelRect.right - wrapRect.left) + 8;

    if (leftCandidate >= 8) {
        card.style.left = leftCandidate + 'px';
        card.style.right = 'auto';
        card.style.top = Math.max(8, (panelRect.top - wrapRect.top)) + 'px';
    } else if (rightCandidate + cardWidth <= wrapRect.width - 8) {
        card.style.left = rightCandidate + 'px';
        card.style.right = 'auto';
        card.style.top = Math.max(8, (panelRect.top - wrapRect.top)) + 'px';
    } else {
        card.style.left = Math.max(8, wrapRect.width - cardWidth - 12) + 'px';
        card.style.right = 'auto';
        card.style.top = Math.min(wrapRect.height - 210, (panelRect.bottom - wrapRect.top) + 6) + 'px';
    }
}

window.zoomToLatestFoxArea = function(areaName) {
    var targetPt = latestKnownAreaPoints[areaName] || getFallbackLatestVisitedHouseForArea(areaName);

    if (targetPt && targetPt.latlng) {
        map.flyTo(targetPt.latlng, 15, { animate: true, duration: 1.0 });
        if (targetPt.marker) {
            setTimeout(function() {
                targetPt.marker.openPopup();
            }, 650);
        }
    } else {
        alert("Nog geen bekend punt (RD-punt of bezochte club) voor deelgebied " + areaName + ".");
    }
};

window.handleFoxAreaBtnClick = function(areaName) {
    var now = Date.now();
    var lastTap = lastFoxTapTimeByArea[areaName] || 0;

    if (now - lastTap < 340) {
        lastFoxTapTimeByArea[areaName] = 0;
        if (singleClickFoxTimerByArea[areaName]) {
            clearTimeout(singleClickFoxTimerByArea[areaName]);
            delete singleClickFoxTimerByArea[areaName];
        }
        window.zoomToLatestFoxArea(areaName);
    } else {
        lastFoxTapTimeByArea[areaName] = now;
        if (singleClickFoxTimerByArea[areaName]) {
            clearTimeout(singleClickFoxTimerByArea[areaName]);
        }
        singleClickFoxTimerByArea[areaName] = setTimeout(function() {
            delete singleClickFoxTimerByArea[areaName];
            if (selectedFoxInfoArea === areaName) {
                selectedFoxInfoArea = null;
            } else {
                selectedFoxInfoArea = areaName;
            }
            window.renderFoxStatusButtons();
        }, 240);
    }
};

function formatLiveStatusTimer(updatedAtMs, fallbackText) {
    if (!updatedAtMs || isNaN(updatedAtMs)) {
        return fallbackText || "Onbekend";
    }
    var diffSec = Math.max(0, Math.floor((Date.now() - Number(updatedAtMs)) / 1000));
    if (diffSec >= MAX_STATUS_TIMER_SECONDS) {
        return "12u 00m 00s (max 12u)";
    }
    var hours = Math.floor(diffSec / 3600);
    var mins = Math.floor((diffSec % 3600) / 60);
    var secs = diffSec % 60;
    var mmStr = String(mins).padStart(2, '0');
    var ssStr = String(secs).padStart(2, '0');
    if (hours > 0) {
        return `${hours}u ${mmStr}m ${ssStr}s`;
    }
    return `${mins}m ${ssStr}s`;
}

function getFoxStatusInfoBoxData(areaName, colorKey, cfg, stObj) {
    var masterMetrics = (lastComputedMapState && lastComputedMapState.foxStatusMetrics && lastComputedMapState.foxStatusMetrics[areaName])
        ? lastComputedMapState.foxStatusMetrics[areaName]
        : null;

    var statusUpdatedAt = (masterMetrics && masterMetrics.statusUpdatedAt) ? masterMetrics.statusUpdatedAt : (stObj.updatedAt || null);
    if (!statusUpdatedAt && stObj.timeFormatted && stObj.timeFormatted.includes(':')) {
        var tParts = stObj.timeFormatted.split(':');
        var dTemp = new Date();
        dTemp.setHours(parseInt(tParts[0], 10) || 0, parseInt(tParts[1], 10) || 0, 0, 0);
        if (dTemp.getTime() > Date.now()) dTemp.setDate(dTemp.getDate() - 1);
        statusUpdatedAt = dTemp.getTime();
    }

    var timerStr = formatLiveStatusTimer(statusUpdatedAt, masterMetrics ? masterMetrics.statusDurationText : "");
    var sinceStr = stObj.timeFormatted ? ` (sinds ${stObj.timeFormatted})` : '';
    var statusTitleText = `Op status ${cfg.label}${sinceStr}:`;

    var myTravelHtml = `<span style="color:#95a5a6;">Wachten op jouw GPS / vossenpunt...</span>`;
    if (masterMetrics && masterMetrics.estimatedCoord) {
        if (currentUserId && masterMetrics.userRoutes && masterMetrics.userRoutes[currentUserId]) {
            var myRoute = masterMetrics.userRoutes[currentUserId];
            myTravelHtml = `<b style="color:#2ecc71;">${myRoute.distKm} km</b> over de weg • <b style="color:#2ecc71;">~${myRoute.durationMin} min</b>`;
        } else if (isAdmin && (!currentUserId || !masterMetrics.userRoutes || !masterMetrics.userRoutes[currentUserId])) {
            myTravelHtml = `<span style="color:#bdc3c7;">Admin-sessie (geen eigen veld-GPS actief)</span>`;
        } else {
            myTravelHtml = `<span style="color:#f39c12;">Wordt berekend door Master Engine...</span>`;
        }
    } else {
        myTravelHtml = `<span style="color:#95a5a6;">Nog geen vossenlocatie bekend</span>`;
    }

    var closestUserHtml = `<span style="color:#95a5a6;">Geen online hunter in de buurt</span>`;
    if (masterMetrics && masterMetrics.estimatedCoord) {
        if (masterMetrics.closestOnlineUser && masterMetrics.closestOnlineUser.name) {
            var cUser = masterMetrics.closestOnlineUser;
            closestUserHtml = `<b style="color:#5dade2;">🚗 ${cUser.name}</b> (${cUser.distKm} km • ~${cUser.durationMin} min)`;
        } else {
            closestUserHtml = `<span style="color:#95a5a6;">Geen actieve online hunters</span>`;
        }
    } else {
        closestUserHtml = `<span style="color:#95a5a6;">Nog geen vossenlocatie bekend</span>`;
    }

    var hasCoord = !!(masterMetrics && Array.isArray(masterMetrics.estimatedCoord) && masterMetrics.estimatedCoord.length === 2);
    var cLat = hasCoord ? masterMetrics.estimatedCoord[0] : null;
    var cLng = hasCoord ? masterMetrics.estimatedCoord[1] : null;

    return {
        statusTitleText: statusTitleText,
        statusUpdatedAt: statusUpdatedAt || '',
        timerStr: timerStr,
        myTravelHtml: myTravelHtml,
        closestUserHtml: closestUserHtml,
        hasCoord: hasCoord,
        cLat: cLat,
        cLng: cLng,
        borderColor: cfg.bg
    };
}

window.updateFoxFixedDetailCard = function() {
    var card = document.getElementById('fox-fixed-detail-card');
    if (!card) return;

    if (!selectedFoxInfoArea) {
        if (card.style.display !== 'none') card.style.display = 'none';
        return;
    }

    var areaName = selectedFoxInfoArea;
    var stObj = currentFoxStatuses[areaName] || {};
    var colorKey = stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";
    var cfg = foxStatusConfig[colorKey] || foxStatusConfig["grijs"];

    var infoData = getFoxStatusInfoBoxData(areaName, colorKey, cfg, stObj);

    if (card.style.display === 'none') {
        card.style.display = 'flex';
        positionFoxDetailCard();
    }

    card.style.borderTop = `4px solid ${cfg.bg}`;

    var dotEl = document.getElementById('fox-detail-color-dot');
    if (dotEl) dotEl.style.backgroundColor = cfg.bg;

    var titleEl = document.getElementById('fox-detail-title');
    var expectedTitle = `${areaName} (${cfg.label})`;
    if (titleEl && titleEl.textContent !== expectedTitle) {
        titleEl.textContent = expectedTitle;
    }

    var statusLabelEl = document.getElementById('fox-detail-status-label');
    if (statusLabelEl && statusLabelEl.textContent !== infoData.statusTitleText) {
        statusLabelEl.textContent = infoData.statusTitleText;
    }

    var timerValEl = document.getElementById('fox-detail-timer-val');
    if (timerValEl) {
        timerValEl.setAttribute('data-updated-at', String(infoData.statusUpdatedAt));
        if (timerValEl.textContent !== infoData.timerStr) {
            timerValEl.textContent = infoData.timerStr;
        }
    }

    var myTravelEl = document.getElementById('fox-detail-my-travel');
    if (myTravelEl && myTravelEl._lastHtml !== infoData.myTravelHtml) {
        myTravelEl.innerHTML = infoData.myTravelHtml;
        myTravelEl._lastHtml = infoData.myTravelHtml;
    }

    var closestEl = document.getElementById('fox-detail-closest-hunter');
    if (closestEl && closestEl._lastHtml !== infoData.closestUserHtml) {
        closestEl.innerHTML = infoData.closestUserHtml;
        closestEl._lastHtml = infoData.closestUserHtml;
    }

    var zoomBtn = document.getElementById('fox-detail-zoom-btn');
    if (zoomBtn) {
        zoomBtn.onclick = function() {
            window.zoomToLatestFoxArea(areaName);
        };
    }

    var navBtn = document.getElementById('fox-detail-nav-btn');
    if (navBtn) {
        if (infoData.hasCoord) {
            navBtn.style.display = 'block';
            navBtn.onclick = function() {
                window.navigateToAreaPoint(infoData.cLat, infoData.cLng);
            };
        } else {
            navBtn.style.display = 'none';
        }
    }
};

window.renderFoxStatusButtons = function() {
    var listEl = document.getElementById('fox-status-buttons-list');
    if (!listEl) return;

    var visibleAreas = targetAreas.filter(function(areaName) {
        var stObj = currentFoxStatuses[areaName];
        var colorKey = stObj && stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";
        return visibleFoxStatusColors[colorKey] !== false;
    });

    if (visibleAreas.length === 0) {
        listEl.innerHTML = `<div class="fox-status-empty">Geen statussen geselecteerd</div>`;
        selectedFoxInfoArea = null;
        window.updateFoxFixedDetailCard();
        return;
    }

    var emptyMsg = listEl.querySelector('.fox-status-empty');
    if (emptyMsg) emptyMsg.remove();

    targetAreas.forEach(function(areaName) {
        var wrapEl = listEl.querySelector(`.fox-area-status-item-wrap[data-area="${areaName}"]`);
        if (!wrapEl) {
            wrapEl = document.createElement('div');
            wrapEl.className = 'fox-area-status-item-wrap';
            wrapEl.setAttribute('data-area', areaName);
            wrapEl.innerHTML = `
                <button type="button"
                    class="fox-area-status-btn"
                    onclick="window.handleFoxAreaBtnClick('${areaName}')"
                    title="1x klikken: Open vast info-venster • Dubbelklik: Zoom in op laatste punt">
                    <span class="fox-btn-name">${areaName}</span>
                </button>
            `;
            listEl.appendChild(wrapEl);
        }

        var isVisible = visibleAreas.includes(areaName);
        var desiredDisplay = isVisible ? 'flex' : 'none';
        if (wrapEl.style.display !== desiredDisplay) {
            wrapEl.style.display = desiredDisplay;
        }

        if (!isVisible && selectedFoxInfoArea === areaName) {
            selectedFoxInfoArea = null;
        }

        var stObj = currentFoxStatuses[areaName] || {};
        var colorKey = stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";
        var cfg = foxStatusConfig[colorKey] || foxStatusConfig["grijs"];
        var isSelected = (selectedFoxInfoArea === areaName);

        var btnEl = wrapEl.querySelector('.fox-area-status-btn');
        if (btnEl) {
            var nextClass = `fox-area-status-btn status-color-${colorKey}` + (isSelected ? ' is-selected-area' : '');
            if (btnEl.className !== nextClass) btnEl.className = nextClass;
            if (btnEl.style.backgroundColor !== cfg.bg) btnEl.style.backgroundColor = cfg.bg;
            if (btnEl.style.borderColor !== cfg.border) btnEl.style.borderColor = cfg.border;
            if (btnEl.style.color !== cfg.text) btnEl.style.color = cfg.text;
        }
    });

    window.updateFoxFixedDetailCard();
};

setInterval(function() {
    if (!selectedFoxInfoArea) return;
    var timerEl = document.getElementById('fox-detail-timer-val');
    if (timerEl) {
        var ts = parseInt(timerEl.getAttribute('data-updated-at'), 10);
        if (ts && !isNaN(ts)) {
            var nextText = formatLiveStatusTimer(ts, "");
            if (timerEl.textContent !== nextText) {
                timerEl.textContent = nextText;
            }
        }
    }
}, 1000);

injectFoxStatusPanel();

/* --- DUIDELIJKE IN-APP MELDING BIJ VOSSEN STATUSWIJZIGING (MET 6S WITTE BALK + 0.5S SLUITEN) --- */
var foxAlertTimeout = null;
var foxAlertCloseDelayTimeout = null;

function closeFoxAlertToastNow() {
    if (foxAlertTimeout) clearTimeout(foxAlertTimeout);
    if (foxAlertCloseDelayTimeout) clearTimeout(foxAlertCloseDelayTimeout);
    var toast = document.getElementById('fox-alert-toast');
    if (toast) toast.style.display = 'none';
}

function ensureFoxAlertBannerUI() {
    if (document.getElementById('fox-alert-toast')) return;
    
    var toast = document.createElement('div');
    toast.id = 'fox-alert-toast';
    toast.style.display = 'none';
    
    toast.innerHTML = `
        <span id="fox-alert-toast-text"></span>
        <div style="display:flex; flex-shrink:0;">
            <button type="button" id="fox-alert-toast-zoom-btn">Zoom in</button>
            <button type="button" id="fox-alert-toast-close-btn">Sluiten</button>
        </div>
        <div class="toast-progress-wrap">
            <div id="fox-alert-toast-progress-bar" class="toast-progress-bar"></div>
        </div>
    `;
    
    document.body.insertBefore(toast, document.body.firstChild);

    document.getElementById('fox-alert-toast-close-btn').addEventListener('click', function() {
        closeFoxAlertToastNow();
    });
}

function triggerFoxStatusAlert(areaName, colorKey, timeFormatted) {
    ensureFoxAlertBannerUI();
    
    var cfg = foxStatusConfig[colorKey] || foxStatusConfig["grijs"];
    
    // Alleen bij Groen het lange vibratie/geluidspatroon, de rest kort
    if (colorKey === 'groen') {
        playAlertSound('green');
        if ('vibrate' in navigator) navigator.vibrate([400, 120, 400, 120, 600]);
    } else {
        if ('vibrate' in navigator) navigator.vibrate([250, 100, 250]);
    }

    var toast = document.getElementById('fox-alert-toast');
    var textEl = document.getElementById('fox-alert-toast-text');
    var zoomBtn = document.getElementById('fox-alert-toast-zoom-btn');
    var progressBar = document.getElementById('fox-alert-toast-progress-bar');

    // Stel de kleuren dynamisch in op basis van de config
    toast.style.backgroundColor = cfg.bg;
    toast.style.borderBottomColor = cfg.border;
    toast.style.color = cfg.text;

    var timePart = timeFormatted ? ` (om ${timeFormatted})` : '';
    
    if (colorKey === 'groen') {
        textEl.textContent = `DEELGEBIED ${areaName.toUpperCase()} MAG WEER GEHUNT WORDEN! Status is GROEN${timePart}.`;
    } else {
        textEl.textContent = `STATUSWIJZIGING: ${areaName.toUpperCase()} is nu ${cfg.label.toUpperCase()}${timePart}.`;
    }

    zoomBtn.onclick = function() {
        window.zoomToLatestFoxArea(areaName);
        selectedFoxInfoArea = areaName;
        window.renderFoxStatusButtons();
        closeFoxAlertToastNow();
    };

    toast.style.display = 'flex';

    // Start de witte voortgangsbalk (6 seconden)
    if (progressBar) {
        progressBar.style.transition = 'none';
        progressBar.style.width = '0%';
        void progressBar.offsetWidth; // Forceer reflow
        progressBar.style.transition = 'width 6s linear';
        progressBar.style.width = '100%';
    }

    if (foxAlertTimeout) clearTimeout(foxAlertTimeout);
    if (foxAlertCloseDelayTimeout) clearTimeout(foxAlertCloseDelayTimeout);

    // Na 6 seconden sluiten
    foxAlertTimeout = setTimeout(function() {
        foxAlertCloseDelayTimeout = setTimeout(function() {
            closeFoxAlertToastNow();
        }, 500);
    }, 6000);
}

var isInitialFoxStatusLoad = true;
var prevFoxStatusMap = {};

db.ref('foxStatuses').on('value', function(snapshot) {
    var data = snapshot.val() || {};
    currentFoxStatuses = data;
    window.renderFoxStatusButtons();

    targetAreas.forEach(function(areaName) {
        var stObj = data[areaName] || {};
        var curr = stObj.status ? normalizeFoxStatusKey(stObj.status) : "grijs";

        if (!isInitialFoxStatusLoad && prevFoxStatusMap[areaName] && prevFoxStatusMap[areaName] !== curr) {
            var cfg = foxStatusConfig[curr] || foxStatusConfig["grijs"];

            // Activeer de nieuwe dynamische melding voor ALLE kleuren
            triggerFoxStatusAlert(areaName, curr, stObj.timeFormatted || "");

            // OS Pushnotificatie voor op de achtergrond
            if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
                navigator.serviceWorker.ready.then(function(reg) {
                    var notifTitle = curr === "groen"
                        ? `JA! ${areaName} mag weer gehunt worden!`
                        : `Vossen Status ${areaName}: ${cfg.label}`;
                    var notifBody = curr === "groen"
                        ? `Deelgebied ${areaName} staat weer op GROEN! Klik om op de kaart te kijken.`
                        : `Status van ${areaName} is via Telegram gewijzigd in ${cfg.label}!`;

                    reg.showNotification(notifTitle, {
                        body: notifBody,
                        icon: 'icon-192.png', //// hier foto voor melding
                        badge: 'icon-192.png',
                        vibrate: curr === "groen" ? [400, 120, 400, 120, 600] : [250, 100, 250],
                        tag: 'fox-status-' + areaName,
                        renotify: true
                    });
                });
            }
        }
        prevFoxStatusMap[areaName] = curr;
    });
    isInitialFoxStatusLoad = false;
});

db.ref('adminSettings/visibleFoxStatuses').on('value', function(snapshot) {
    var val = snapshot.val();
    if (val && typeof val === 'object') {
        Object.keys(foxStatusConfig).forEach(function(k) {
            visibleFoxStatusColors[k] = (val[k] !== false);
        });
    } else {
        Object.keys(foxStatusConfig).forEach(function(k) {
            visibleFoxStatusColors[k] = true;
        });
    }
    window.renderFoxStatusButtons();
    if (typeof window.syncAdminFoxFilterCheckboxes === 'function') {
        window.syncAdminFoxFilterCheckboxes();
    }
});

/* --- TEGENHUNT POPUP MIDDEN OP HET SCHERM + AUTO-ZOOM --- */
var currentCounterHuntData = null;
var lastHandledCounterHuntId = null;
var counterHuntDismissTimeouts = [];
var configuredCounterHuntAlertMinutes = 5;
var hasTriggeredExpiredNoticeForId = {};

// Luister voor zowel Hunters als Admins naar de ingestelde na-timer in Firebase
db.ref('adminSettings/counterHuntAlertMinutes').on('value', function(snapshot) {
    var val = parseFloat(snapshot.val());
    if (!isNaN(val) && val > 0) {
        configuredCounterHuntAlertMinutes = val;
    } else {
        configuredCounterHuntAlertMinutes = 5;
    }
    evaluateCounterHuntAutoHide();
});

function getCounterHuntNoticeTimeoutMs() {
    return Math.max(1, Number(configuredCounterHuntAlertMinutes) || 5) * 60 * 1000;
}

function isCounterHuntEventDismissed(id, type) {
    if (!id) return false;
    return localStorage.getItem('jh_dismissed_ch_' + type + '_' + id) === '1';
}

function markCounterHuntEventDismissed(id, type) {
    if (!id) return;
    localStorage.setItem('jh_dismissed_ch_' + type + '_' + id, '1');
}

function clearCounterHuntAutoHideTimers() {
    counterHuntDismissTimeouts.forEach(function(t) { clearTimeout(t); });
    counterHuntDismissTimeouts = [];
}

window.isCounterHuntNotificationActive = function() {
    var overlay = document.getElementById('counterhunt-modal-overlay');
    var miniBar = document.getElementById('counterhunt-mini-bar');
    var overlayOpen = !!(overlay && overlay.style.display === 'flex');
    var miniOpen = !!(miniBar && miniBar.style.display === 'flex');
    return overlayOpen || miniOpen;
};

function notifyAdminPanelCounterHuntState() {
    if (typeof window.updateAdminSettingsPanelStatus === 'function') {
        window.updateAdminSettingsPanelStatus();
    }
}

function getBearingFromDirectionName(dirName) {
    var d = String(dirName || "").toLowerCase().replace(/[\s\-_]/g, "");
    var mapBearings = {
        "noord": 0, "n": 0,
        "noordoost": 45, "no": 45,
        "oost": 90, "o": 90,
        "zuidoost": 135, "zo": 135,
        "zuid": 180, "z": 180,
        "zuidwest": 225, "zw": 225,
        "west": 270, "w": 270,
        "noordwest": 315, "nw": 315
    };
    return mapBearings[d] !== undefined ? mapBearings[d] : null;
}

function computeDestLatLngSimple(lat, lng, distMeters, bearingDeg) {
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

function renderCounterHuntSectorOnMap(chData) {
    counterHuntHighlightLayer.clearLayers();
    if (!chData || chData.state !== 'active') {
        amalgamaBaseCircle.setStyle({ color: '#e67e22', fillColor: '#e67e22', weight: 2 });
        return;
    }

    var rem = formatCounterHuntRemaining(chData.expiresAtMs);
    if (rem.expired) {
        amalgamaBaseCircle.setStyle({ color: '#e67e22', fillColor: '#e67e22', weight: 2 });
        return;
    }

    amalgamaBaseCircle.setStyle({ color: '#ff2e2e', fillColor: '#e74c3c', weight: 3.5 });

    var bearing = getBearingFromDirectionName(chData.direction);
    if (bearing !== null) {
        var wedgePoints = [[amalgamaLat, amalgamaLng]];
        for (var a = bearing - 28; a <= bearing + 28; a += 4) {
            var normA = (a + 360) % 360;
            wedgePoints.push(computeDestLatLngSimple(amalgamaLat, amalgamaLng, radiusMeters, normA));
        }
        wedgePoints.push([amalgamaLat, amalgamaLng]);

        var sectorPoly = L.polygon(wedgePoints, {
            color: '#ff0000',
            weight: 3,
            fillColor: '#ff0000',
            fillOpacity: 0.35,
            dashArray: '6, 4'
        }).addTo(counterHuntHighlightLayer);

        sectorPoly.bindTooltip(`TEGENHUNT RICHTING: ${String(chData.direction).toUpperCase()}`, {
            permanent: true,
            direction: 'center',
            className: 'marker-label user-gps-label-inactive'
        });
    }
}

function injectCounterHuntUI() {
    if (document.getElementById('counterhunt-modal-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'counterhunt-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div id="counterhunt-modal-box" class="ch-mode-active">
            <div id="ch-top-timer-wrap">
                <div id="ch-timer-caption">RESTERENDE ZOEKTIJD (30 MIN)</div>
                <div id="ch-giant-timer">30:00</div>
            </div>

            <div id="ch-alert-badge">TEGENHUNT GEPLAKT BIJ CLUBGEBOUW!</div>

            <div id="ch-main-info-grid">
                <div class="ch-info-card">
                    <span class="ch-info-card-label">WINDRICHTING</span>
                    <span class="ch-info-card-val" id="ch-direction-val">Zuid-West</span>
                </div>
                <div class="ch-info-card">
                    <span class="ch-info-card-label">GEPLAKT OM TIJDSTIP</span>
                    <span class="ch-info-card-val" id="ch-time-val">23:01</span>
                </div>
            </div>

            <div id="ch-extra-details">
                Inzet: <b id="ch-points-val">10 punten</b> • Zoek binnen de <b>450m cirkel</b> van <b>Scouting Amalgama</b>!
            </div>

            <div id="ch-raw-msg-box"></div>

            <div class="ch-modal-actions">
                <button type="button" id="ch-btn-zoom-club" class="ch-action-btn ch-btn-primary">
                    Bekijk op Kaart (Scouting Amalgama)
                </button>
                <button type="button" id="ch-btn-nav-club" class="ch-action-btn ch-btn-secondary">
                     Navigeer naar Clubgebouw
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    var mapWrapper = document.getElementById('map-wrapper') || document.body;
    var miniBar = document.createElement('div');
    miniBar.id = 'counterhunt-mini-bar';
    miniBar.style.display = 'none';
    miniBar.innerHTML = `
        <span id="ch-mini-text">TEGENHUNT ACTIEF (Zuid-West) • Geplakt: 23:01</span>
        <span id="ch-mini-timer">30:00</span>
        <span class="ch-mini-open-btn"></span>
    `;
    mapWrapper.appendChild(miniBar);

    document.getElementById('ch-btn-zoom-club').addEventListener('click', function() {
        overlay.style.display = 'none';
        if (currentCounterHuntData && currentCounterHuntData.id) {
            if (currentCounterHuntData.state === 'foiled') {
                markCounterHuntEventDismissed(currentCounterHuntData.id, 'foiled');
            } else if (currentCounterHuntData.state === 'active') {
                var rem = formatCounterHuntRemaining(currentCounterHuntData.expiresAtMs);
                if (rem.expired) {
                    markCounterHuntEventDismissed(currentCounterHuntData.id, 'expired');
                } else {
                    map.flyTo([amalgamaLat, amalgamaLng], 16, { animate: true, duration: 1.0 });
                }
            }
        }
        updateCounterHuntMiniBar();
        notifyAdminPanelCounterHuntState();
    });

    document.getElementById('ch-btn-nav-club').addEventListener('click', function() {
        window.navigateToAreaPoint(amalgamaLat, amalgamaLng);
    });

    miniBar.addEventListener('click', function() {
        overlay.style.display = 'flex';
        miniBar.style.display = 'none';
        notifyAdminPanelCounterHuntState();
    });
}

function formatCounterHuntRemaining(expiresAtMs) {
    var diffSec = Math.floor((Number(expiresAtMs) - Date.now()) / 1000);
    if (diffSec <= 0) return { expired: true, text: "00:00" };
    var mins = Math.floor(diffSec / 60);
    var secs = diffSec % 60;
    return {
        expired: false,
        text: String(mins).padStart(2, '0') + ":" + String(secs).padStart(2, '0')
    };
}

function showExpiredCounterHuntModal(data) {
    var overlay = document.getElementById('counterhunt-modal-overlay');
    var modalBox = document.getElementById('counterhunt-modal-box');
    var timerWrap = document.getElementById('ch-top-timer-wrap');
    var timerCaption = document.getElementById('ch-timer-caption');
    var giantTimer = document.getElementById('ch-giant-timer');
    var alertBadge = document.getElementById('ch-alert-badge');
    var infoGrid = document.getElementById('ch-main-info-grid');
    var extraDetails = document.getElementById('ch-extra-details');
    var rawMsgBox = document.getElementById('ch-raw-msg-box');
    var zoomBtn = document.getElementById('ch-btn-zoom-club');
    var navBtn = document.getElementById('ch-btn-nav-club');

    var now = Date.now();
    var expiredAgoMs = now - Number(data.expiresAtMs || now);
    var maxDisplayMs = getCounterHuntNoticeTimeoutMs();

    renderCounterHuntSectorOnMap(null);
    updateCounterHuntMiniBar();

    if (expiredAgoMs >= maxDisplayMs || isCounterHuntEventDismissed(data.id, 'expired')) {
        if (overlay) overlay.style.display = 'none';
        notifyAdminPanelCounterHuntState();
        return;
    }

    modalBox.className = 'ch-mode-expired';
    timerWrap.style.display = 'flex';
    timerCaption.textContent = 'ZOEKTĲD VERLOPEN (30 MIN VOORBIJ)';
    giantTimer.textContent = '00:00';

    alertBadge.textContent = 'HELAAS! TEGENHUNT NIET GEVONDEN';
    infoGrid.style.display = 'none';
    extraDetails.innerHTML = `Het is jammer genoeg niet gelukt om de tegenhunt (${data.direction || 'Onbekend'}) op tijd te vinden. Deze melding sluit automatisch na <b>${configuredCounterHuntAlertMinutes} min</b>.`;
    rawMsgBox.textContent = data.rawMessage || '';
    zoomBtn.textContent = 'Sluit Melding';
    if (navBtn) navBtn.style.display = 'none';

    overlay.style.display = 'flex';
    notifyAdminPanelCounterHuntState();

    clearCounterHuntAutoHideTimers();
    var remainingHideMs = Math.max(1000, maxDisplayMs - Math.max(0, expiredAgoMs));
    var tId = setTimeout(function() {
        markCounterHuntEventDismissed(data.id, 'expired');
        overlay.style.display = 'none';
        notifyAdminPanelCounterHuntState();
    }, remainingHideMs);
    counterHuntDismissTimeouts.push(tId);
}

function evaluateCounterHuntAutoHide() {
    if (!currentCounterHuntData) return;
    var now = Date.now();
    var maxDisplayMs = getCounterHuntNoticeTimeoutMs();
    var overlay = document.getElementById('counterhunt-modal-overlay');

    if (currentCounterHuntData.state === 'foiled') {
        var foiledTs = Number(currentCounterHuntData.foiledAtMs || currentCounterHuntData.updatedAt || now);
        var ageMs = now - foiledTs;
        if (ageMs >= maxDisplayMs || isCounterHuntEventDismissed(currentCounterHuntData.id, 'foiled')) {
            if (overlay) overlay.style.display = 'none';
            notifyAdminPanelCounterHuntState();
        }
    } else if (currentCounterHuntData.state === 'active') {
        var rem = formatCounterHuntRemaining(currentCounterHuntData.expiresAtMs);
        if (rem.expired) {
            var expAgeMs = now - Number(currentCounterHuntData.expiresAtMs || now);
            if (expAgeMs >= maxDisplayMs || isCounterHuntEventDismissed(currentCounterHuntData.id, 'expired')) {
                if (overlay) overlay.style.display = 'none';
                notifyAdminPanelCounterHuntState();
            }
        }
    }
}

function updateCounterHuntMiniBar() {
    var overlay = document.getElementById('counterhunt-modal-overlay');
    var miniBar = document.getElementById('counterhunt-mini-bar');
    if (!miniBar) return;

    if (!currentCounterHuntData || currentCounterHuntData.state !== 'active') {
        miniBar.style.display = 'none';
        notifyAdminPanelCounterHuntState();
        return;
    }

    var rem = formatCounterHuntRemaining(currentCounterHuntData.expiresAtMs);
    if (rem.expired) {
        miniBar.style.display = 'none';
        counterHuntHighlightLayer.clearLayers();
        amalgamaBaseCircle.setStyle({ color: '#e67e22', fillColor: '#e67e22', weight: 2 });
        notifyAdminPanelCounterHuntState();
        return;
    }

    var isModalOpen = overlay && overlay.style.display === 'flex';
    miniBar.style.display = isModalOpen ? 'none' : 'flex';

    var miniText = document.getElementById('ch-mini-text');
    var miniTimer = document.getElementById('ch-mini-timer');
    if (miniText) {
        miniText.textContent = `TEGENHUNT: ${String(currentCounterHuntData.direction || '').toUpperCase()} (Geplakt ${currentCounterHuntData.timeShort || ''})`;
    }
    if (miniTimer) {
        miniTimer.textContent = `${rem.text}`;
    }
    notifyAdminPanelCounterHuntState();
}

function updateCounterHuntTimersTick() {
    if (!currentCounterHuntData) return;

    if (currentCounterHuntData.state === 'active') {
        var rem = formatCounterHuntRemaining(currentCounterHuntData.expiresAtMs);
        if (rem.expired) {
            if (!hasTriggeredExpiredNoticeForId[currentCounterHuntData.id]) {
                hasTriggeredExpiredNoticeForId[currentCounterHuntData.id] = true;
                showExpiredCounterHuntModal(currentCounterHuntData);
            } else {
                evaluateCounterHuntAutoHide();
            }
            return;
        }
        var giantTimer = document.getElementById('ch-giant-timer');
        if (giantTimer) {
            giantTimer.textContent = rem.text;
        }
        updateCounterHuntMiniBar();
    } else if (currentCounterHuntData.state === 'foiled') {
        evaluateCounterHuntAutoHide();
    }
}

injectCounterHuntUI();
setInterval(updateCounterHuntTimersTick, 1000);

var isInitialCounterHuntLoad = true;

db.ref('counterHunt').on('value', function(snapshot) {
    var data = snapshot.val();
    currentCounterHuntData = data;
    injectCounterHuntUI();
    clearCounterHuntAutoHideTimers();

    var overlay = document.getElementById('counterhunt-modal-overlay');
    var modalBox = document.getElementById('counterhunt-modal-box');
    var timerWrap = document.getElementById('ch-top-timer-wrap');
    var timerCaption = document.getElementById('ch-timer-caption');
    var giantTimer = document.getElementById('ch-giant-timer');
    var alertBadge = document.getElementById('ch-alert-badge');
    var infoGrid = document.getElementById('ch-main-info-grid');
    var dirVal = document.getElementById('ch-direction-val');
    var timeVal = document.getElementById('ch-time-val');
    var extraDetails = document.getElementById('ch-extra-details');
    var rawMsgBox = document.getElementById('ch-raw-msg-box');
    var zoomBtn = document.getElementById('ch-btn-zoom-club');
    var navBtn = document.getElementById('ch-btn-nav-club');

    if (!data) {
        overlay.style.display = 'none';
        renderCounterHuntSectorOnMap(null);
        updateCounterHuntMiniBar();
        notifyAdminPanelCounterHuntState();
        isInitialCounterHuntLoad = false;
        return;
    }

    var now = Date.now();
    var isNewEvent = (data.id && data.id !== lastHandledCounterHuntId);
    var maxDisplayMs = getCounterHuntNoticeTimeoutMs();

    if (data.state === 'active') {
        var rem = formatCounterHuntRemaining(data.expiresAtMs);
        if (rem.expired) {
            hasTriggeredExpiredNoticeForId[data.id] = true;
            showExpiredCounterHuntModal(data);
            isInitialCounterHuntLoad = false;
            return;
        }

        modalBox.className = 'ch-mode-active';
        timerWrap.style.display = 'flex';
        timerCaption.textContent = 'RESTERENDE TIJD OM TE VINDEN';
        giantTimer.textContent = rem.text;

        alertBadge.textContent = 'TEGENHUNT GEPLAKT BIJ ONS CLUBGEBOUW!';
        infoGrid.style.display = 'grid';
        dirVal.textContent = data.direction || 'Onbekend';
        timeVal.textContent = data.timeShort || data.timeFull || '--:--';
        extraDetails.innerHTML = `Kost bij niet vinden: <b>${data.points || 10} punten</b> • Zoek binnen 450m van <b>Scouting Amalgama</b>!`;
        rawMsgBox.textContent = data.rawMessage || '';
        zoomBtn.textContent = 'Sluit & Zoek op Kaart (Scouting Amalgama)';
        if (navBtn) navBtn.style.display = 'block';

        renderCounterHuntSectorOnMap(data);

        if (isNewEvent) {
            lastHandledCounterHuntId = data.id;
            overlay.style.display = 'flex';

            map.flyTo([amalgamaLat, amalgamaLng], 16, { animate: true, duration: 1.2 });

            playAlertSound('counterhunt');
            if ('vibrate' in navigator) navigator.vibrate([600, 150, 600, 150, 800]);

            if (!isInitialCounterHuntLoad && 'serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
                navigator.serviceWorker.ready.then(function(reg) {
                    reg.showNotification("TEGENHUNT GEPLAKT (" + (data.direction || "") + ")!", {
                        body: `Geplakt om ${data.timeShort || ''}! Richting: ${data.direction}. Jullie hebben 30 minuten!`,
                        icon: 'icon-192.png',
                        badge: 'icon-192.png',
                        vibrate: [600, 150, 600, 150, 800],
                        tag: 'counterhunt-alert',
                        renotify: true
                    });
                });
            }
        }
        updateCounterHuntMiniBar();
        notifyAdminPanelCounterHuntState();
    } else if (data.state === 'foiled') {
        renderCounterHuntSectorOnMap(null);
        updateCounterHuntMiniBar();

        var foiledTs = Number(data.foiledAtMs || data.updatedAt || now);
        var foiledAgeMs = Math.max(0, now - foiledTs);
        var alreadyDismissed = isCounterHuntEventDismissed(data.id, 'foiled');

        if (foiledAgeMs < maxDisplayMs && !alreadyDismissed) {
            lastHandledCounterHuntId = data.id;

            modalBox.className = 'ch-mode-foiled';
            timerWrap.style.display = 'flex';
            timerCaption.textContent = 'TEGENHUNT SUCCESVOL VERIJDELD!';
            giantTimer.textContent = `+${data.points || 10} PT`;

            alertBadge.textContent = `GEFELICITEERD! CODE ${data.code || ''} GEVONDEN!`;
            infoGrid.style.display = 'none';
            extraDetails.innerHTML = `De tegenhunt met code <b>${data.code || ''}</b> is verijdeld! Dit levert jullie <b>${data.points || 10} punten</b> op! (Sluit automatisch na ${configuredCounterHuntAlertMinutes} min)`;
            rawMsgBox.textContent = data.rawMessage || '';
            zoomBtn.textContent = 'Sluit Melding';
            if (navBtn) navBtn.style.display = 'none';

            overlay.style.display = 'flex';
            notifyAdminPanelCounterHuntState();

            if (!isInitialCounterHuntLoad) {
                playAlertSound('foiled');
                if ('vibrate' in navigator) navigator.vibrate([250, 100, 250, 100, 400]);

                if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
                    navigator.serviceWorker.ready.then(function(reg) {
                        reg.showNotification("Tegenhunt Verijdeld! (+" + (data.points || 10) + " punten)", {
                            body: `Code ${data.code || ''} is gevonden! Goed gewerkt!`,
                            icon: 'icon-192.png',
                            badge: 'icon-192.png',
                            tag: 'counterhunt-alert',
                            renotify: true
                        });
                    });
                }
            }

            var remainingHideMs = Math.max(1000, maxDisplayMs - foiledAgeMs);
            var hideTimer = setTimeout(function() {
                markCounterHuntEventDismissed(data.id, 'foiled');
                overlay.style.display = 'none';
                notifyAdminPanelCounterHuntState();
            }, remainingHideMs);
            counterHuntDismissTimeouts.push(hideTimer);
        } else {
            overlay.style.display = 'none';
            notifyAdminPanelCounterHuntState();
        }
    }

    isInitialCounterHuntLoad = false;
});