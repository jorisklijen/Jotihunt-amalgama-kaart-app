/* ==========================================================================
   4B. ADMIN-UI.JS - RD-PUNT MODAL, BEHEERPANEEL & ADMIN ACTIES
   (Wordt uitsluitend ingeladen voor de Admin)
   ========================================================================== */

window.setAreaLockedTarget = function(area, houseName) {
    if (!isAdmin || !area) return;
    var cleanTarget = (houseName && houseName.trim() !== "") ? houseName.trim() : null;

    if (!adminSettings.lockedTargets) adminSettings.lockedTargets = {};
    if (cleanTarget) {
        adminSettings.lockedTargets[area] = cleanTarget;
    } else {
        delete adminSettings.lockedTargets[area];
    }

    claimMasterLockNow();
    db.ref('adminSettings/lockedTargets/' + area).set(cleanTarget).then(function() {
        window.calculateAndPublishMapState(true);
    });
};

window.updateAdminSettingsPanelStatus = function() {
    var statusDot = document.getElementById('admin-max-hours-status-dot');
    var labelEl = document.getElementById('admin-max-hours-label');
    var subtextEl = document.getElementById('admin-max-hours-subtext');

    var chTimerDot = document.getElementById('admin-ch-timer-status-dot');
    var chTimerLabel = document.getElementById('admin-ch-timer-label');
    var chTimerSubtext = document.getElementById('admin-ch-timer-subtext');
    var chTimerInput = document.getElementById('admin-ch-timer-input');

    var altRouteDot = document.getElementById('admin-alt-route-status-dot');
    var altRouteToggle = document.getElementById('admin-alt-route-toggle');
    var altRouteLabel = document.getElementById('admin-alt-route-label');
    var altRouteSubtext = document.getElementById('admin-alt-route-subtext');

    var routeSpeedDot = document.getElementById('admin-route-speed-status-dot');
    var routeSpeedToggle = document.getElementById('admin-route-speed-toggle');
    var routeSpeedLabel = document.getElementById('admin-route-speed-label');
    var routeSpeedSubtext = document.getElementById('admin-route-speed-subtext');

    var areaStatusList = document.getElementById('admin-area-growth-list');

    if (!statusDot || !labelEl || !subtextEl) return;

    var activeAreas = Object.keys(areaCappedStatus);
    var anyCapped = activeAreas.some(function(a) { return areaCappedStatus[a].isCapped; });

    statusDot.className = 'admin-status-dot ' + (anyCapped ? 'status-dot-red' : 'status-dot-green');
    statusDot.title = anyCapped
        ? 'Maximale groeitijd is bereikt voor één of meer gebieden'
        : 'Groei actief (maximale groeitijd nog niet bereikt)';

    labelEl.classList.toggle('capped-reached', anyCapped);
    subtextEl.classList.toggle('capped-reached', anyCapped);

    // Status van de Tegenhunt melding (wordt lichtgrijs als er een melding actief is)
    var isChNoticeActive = !!(typeof window.isCounterHuntNotificationActive === 'function' && window.isCounterHuntNotificationActive());
    if (chTimerInput && document.activeElement !== chTimerInput && adminSettings.counterHuntAlertMinutes) {
        chTimerInput.value = adminSettings.counterHuntAlertMinutes;
    }
    if (chTimerDot) {
        chTimerDot.className = 'admin-status-dot ' + (isChNoticeActive ? 'status-dot-green' : 'status-dot-red');
        chTimerDot.title = isChNoticeActive
            ? 'Er is momenteel een Tegenhunt-melding actief'
            : 'Geen actieve Tegenhunt-melding op dit moment';
    }
    if (chTimerLabel) {
        chTimerLabel.classList.toggle('capped-reached', isChNoticeActive);
    }
    if (chTimerSubtext) {
        chTimerSubtext.classList.toggle('capped-reached', isChNoticeActive);
    }

    var altEnabled = !!adminSettings.showAltQuietRoute;
    var isAltRed = !altEnabled;

    if (altRouteToggle && document.activeElement !== altRouteToggle) {
        altRouteToggle.checked = altEnabled;
    }
    if (altRouteDot) {
        altRouteDot.className = 'admin-status-dot ' + (isAltRed ? 'status-dot-red' : 'status-dot-green');
        altRouteDot.title = altEnabled ? 'Alternatieve route ingeschakeld' : 'Alternatieve route uitgeschakeld';
    }
    if (altRouteLabel) {
        altRouteLabel.classList.toggle('capped-reached', isAltRed);
    }
    if (altRouteSubtext) {
        altRouteSubtext.classList.toggle('capped-reached', isAltRed);
    }

    var routeSpeedEnabled = !!adminSettings.useRouteSpeedCalculation;
    var isRouteSpeedRed = !routeSpeedEnabled;

    if (routeSpeedToggle && document.activeElement !== routeSpeedToggle) {
        routeSpeedToggle.checked = routeSpeedEnabled;
    }
    if (routeSpeedDot) {
        routeSpeedDot.className = 'admin-status-dot ' + (isRouteSpeedRed ? 'status-dot-red' : 'status-dot-green');
        routeSpeedDot.title = routeSpeedEnabled
            ? 'Loopsnelheid o.b.v. wandelroute ingeschakeld'
            : 'Loopsnelheid o.b.v. hemelsbrede afstand (standaard)';
    }
    if (routeSpeedLabel) {
        routeSpeedLabel.classList.toggle('capped-reached', isRouteSpeedRed);
    }
    if (routeSpeedSubtext) {
        routeSpeedSubtext.classList.toggle('capped-reached', isRouteSpeedRed);
    }

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
};

function updateAdminSettingsPanelStatus() {
    window.updateAdminSettingsPanelStatus();
}

function injectAdminUI() {
    if (document.getElementById('rd-modal-overlay')) return;

    var style = document.createElement('style');
    style.innerHTML = `
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

        #admin-settings-panel {
            position: absolute; top: 12px; left: 54px; z-index: 950;
            background: #2c3e50; color: #ecf0f1;
            border: 1px solid #4a6278; border-radius: 8px;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
            width: 280px; max-width: 88vw;
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
        #admin-max-hours-input, #admin-ch-timer-input {
            width: 60px; padding: 5px 6px; border-radius: 5px;
            border: 1px solid #4a6278; background: #34495e; color: #ffffff;
            font-size: 0.85rem; font-weight: bold; text-align: center; outline: none;
        }
        #admin-max-hours-input:focus, #admin-ch-timer-input:focus { border-color: #3498db; }
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
            transition: color 0.2s ease;
        }
        .admin-area-status-item.capped-reached {
            color: #dcdde1 !important;
        }
        .admin-target-lock-select {
            width: 100%; padding: 4px 6px; font-size: 0.72rem;
            background: #34495e; color: #ecf0f1; border: 1px solid #4a6278;
            border-radius: 4px; font-weight: 600; outline: none; cursor: pointer;
        }
        .admin-fox-colors-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 5px;
            width: 100%;
        }
        .admin-fox-color-pill {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 0.73rem;
            color: #ecf0f1;
            cursor: pointer;
            background: #34495e;
            padding: 5px 6px;
            border-radius: 4px;
            border: 1px solid #4a6278;
            font-weight: 600;
            justify-content: flex-start;
        }
        .admin-fox-color-pill input {
            margin: 0;
            cursor: pointer;
        }
    `;
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.id = 'rd-modal-overlay';
    overlay.innerHTML = `
        <div id="rd-modal-box">
            <h3 id="rd-modal-title">RD-Punt Toevoegen</h3>

            <div class="rd-field-group">
                <label for="rd-type-select">Type punt (Naam):</label>
                <select id="rd-type-select" class="rd-select type-hint">
                    <option value="Hint">Hint</option>
                    <option value="Hunt">Hunt</option>
                    <option value="Anders">Anders</option>
                </select>
                <span id="rd-modal-anders-note">Bij 'Anders' wordt geen deelgebied en geen tijdstip opgeslagen.</span>
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
                <span id="rd-modal-hint-note">Voor een 'Hint' zijn alleen hele uren (:00) toegestaan.</span>
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
                        <span id="admin-ch-timer-status-dot" class="admin-status-dot status-dot-red" title="Geen actieve Tegenhunt-melding"></span>
                        <label id="admin-ch-timer-label" for="admin-ch-timer-input">Tegenhunt melding na-timer (<b>X</b> min):</label>
                    </div>
                    <input type="number" id="admin-ch-timer-input" min="1" max="60" step="1" value="5">
                </div>
                <div id="admin-ch-timer-subtext" class="admin-setting-subtext">
                    Verbergt de melding (verijdeld of verlopen) automatisch na X minuten en toont deze niet opnieuw bij herladen.
                </div>

                <hr class="admin-divider">

                <div class="admin-setting-row">
                    <div class="admin-setting-label-wrap">
                        <span id="admin-alt-route-status-dot" class="admin-status-dot status-dot-green" title="Alternatieve route actief"></span>
                        <label id="admin-alt-route-label" for="admin-alt-route-toggle">Toon alternatieve parallelroute (mijd N-wegen):</label>
                    </div>
                    <input type="checkbox" id="admin-alt-route-toggle" checked>
                </div>
                <div id="admin-alt-route-subtext" class="admin-setting-subtext">
                    Berekent een 2e doelgerichte route over de hele keten die N-wegen en dubbele wegen mijdt.
                </div>

                <hr class="admin-divider">

                <div class="admin-setting-row">
                    <div class="admin-setting-label-wrap">
                        <span id="admin-route-speed-status-dot" class="admin-status-dot status-dot-red" title="Loopsnelheid o.b.v. hemelsbreed"></span>
                        <label id="admin-route-speed-label" for="admin-route-speed-toggle">Loopsnelheid o.b.v. wandelroute (i.p.v. hemelsbreed):</label>
                    </div>
                    <input type="checkbox" id="admin-route-speed-toggle">
                </div>
                <div id="admin-route-speed-subtext" class="admin-setting-subtext">
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
            claimMasterLockNow();
            db.ref('adminSettings').update({
                maxCircleGrowthHours: val,
                updatedAt: Date.now()
            }).then(function() {
                window.calculateAndPublishMapState(true);
            });
        });

        var chTimerInput = document.getElementById('admin-ch-timer-input');
        chTimerInput.addEventListener('change', function() {
            var val = parseFloat(this.value);
            if (isNaN(val) || val <= 0) {
                val = 5;
                this.value = 5;
            }
            adminSettings.counterHuntAlertMinutes = val;
            updateAdminSettingsPanelStatus();
            claimMasterLockNow();
            db.ref('adminSettings').update({
                counterHuntAlertMinutes: val,
                updatedAt: Date.now()
            });
        });

        var altRouteToggle = document.getElementById('admin-alt-route-toggle');
        altRouteToggle.addEventListener('change', function() {
            var enabled = !!this.checked;
            adminSettings.showAltQuietRoute = enabled;
            updateAdminSettingsPanelStatus();
            claimMasterLockNow();
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
            claimMasterLockNow();
            db.ref('adminSettings').update({
                useRouteSpeedCalculation: enabled,
                updatedAt: Date.now()
            }).then(function() {
                window.calculateAndPublishMapState(true);
            });
        });

        updateAdminSettingsPanelStatus();

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

    injectAdminFoxStatusControls();
}

function injectAdminFoxStatusControls() {
    var settingsBody = document.getElementById('admin-settings-body');
    if (!settingsBody || document.getElementById('admin-fox-status-filter-section')) return;

    var filterSection = document.createElement('div');
    filterSection.id = 'admin-fox-status-filter-section';
    filterSection.style.display = 'flex';
    filterSection.style.flexDirection = 'column';
    filterSection.style.gap = '6px';

    var orderedColorKeys = (typeof foxStatusOrder !== 'undefined' && Array.isArray(foxStatusOrder))
        ? foxStatusOrder
        : ["rood", "oranje", "geel", "groen", "blauw", "grijs"];

    var colorCheckboxesHtml = orderedColorKeys.map(function(colorKey) {
        var cfg = foxStatusConfig[colorKey];
        if (!cfg) return '';
        var isChecked = visibleFoxStatusColors[colorKey] !== false ? 'checked' : '';
        return `
            <label class="admin-fox-color-pill">
                <input type="checkbox" class="admin-fox-color-cb" data-color="${colorKey}" ${isChecked} style="accent-color:${cfg.bg};">
                <span style="width:9px; height:9px; border-radius:50%; background:${cfg.bg}; display:inline-block; flex-shrink:0;"></span>
                <span>${cfg.label}</span>
            </label>
        `;
    }).join('');

    var manualOverrideRowsHtml = targetAreas.map(function(areaName) {
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; font-size:0.73rem;">
                <span style="font-weight:600; color:#bdc3c7;">${areaName}:</span>
                <select class="admin-target-lock-select admin-manual-fox-status" data-area="${areaName}" style="width:120px; padding:2px 5px;">
                    <option value="rood">Rood</option>
                    <option value="oranje">Oranje</option>
                    <option value="geel">Geel</option>
                    <option value="groen">Groen</option>
                    <option value="blauw">Blauw</option>
                    <option value="grijs" selected>Grijs</option>
                </select>
            </div>
        `;
    }).join('');

    var currentUserPwdVal = (typeof firebaseAuthConfig !== 'undefined' && firebaseAuthConfig.userPassword)
        ? firebaseAuthConfig.userPassword
        : "1111";

    filterSection.innerHTML = `
        <hr class="admin-divider">
        <div class="admin-setting-row">
            <div class="admin-setting-label-wrap">
                <span id="admin-fox-filter-dot" class="admin-status-dot status-dot-green"></span>
                <label id="admin-fox-filter-label" style="color:#dcdde1;">Toon statussen in Vossen-menu:</label>
            </div>
        </div>
        <div class="admin-fox-colors-grid">
            ${colorCheckboxesHtml}
        </div>
        <div class="admin-setting-subtext">
            Vink aan welke Telegram-statuskleuren zichtbaar zijn in het Vossen Status-menu (gesorteerd op regenboogvolgorde).
        </div>

        <details style="margin-top:4px; background:#243342; padding:6px 8px; border-radius:5px; border:1px solid #3d566e;">
            <summary style="font-size:0.74rem; font-weight:bold; color:#85c1e9; cursor:pointer;">Handmatig vossenstatus wijzigen</summary>
            <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px;">
                ${manualOverrideRowsHtml}
            </div>
        </details>

        <hr class="admin-divider">
        <div class="admin-setting-row">
            <div class="admin-setting-label-wrap">
                <span class="admin-status-dot status-dot-green"></span>
                <label for="admin-user-password-input" style="color:#dcdde1;">Gebruikerswachtwoord (Hunters):</label>
            </div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
            <input type="text" id="admin-user-password-input" value="${currentUserPwdVal.replace(/"/g, '&quot;')}" placeholder="Nieuw wachtwoord" style="flex:1; padding:5px 8px; border-radius:4px; border:1px solid #4a6278; background:#34495e; color:#ffffff; font-size:0.78rem; font-weight:bold; outline:none;">
            <button type="button" id="admin-save-user-password-btn" style="padding:5px 10px; border-radius:4px; border:none; background:#27ae60; color:#ffffff; font-size:0.75rem; font-weight:bold; cursor:pointer;">Opslaan</button>
        </div>
        <div class="admin-setting-subtext">
            Bij wijzigen worden alle ingelogde gebruikers automatisch uitgelogd en moeten zij met het nieuwe wachtwoord inloggen.
        </div>
    `;

    settingsBody.appendChild(filterSection);

    var checkboxes = filterSection.querySelectorAll('.admin-fox-color-cb');
    checkboxes.forEach(function(cb) {
        cb.addEventListener('change', function() {
            var colorKey = this.getAttribute('data-color');
            visibleFoxStatusColors[colorKey] = !!this.checked;
            claimMasterLockNow();
            db.ref('adminSettings/visibleFoxStatuses').set(visibleFoxStatusColors);
        });
    });

    var manualSelects = filterSection.querySelectorAll('.admin-manual-fox-status');
    manualSelects.forEach(function(sel) {
        sel.addEventListener('change', function() {
            if (!isAdmin) return;
            var areaName = this.getAttribute('data-area');
            var chosenColor = this.value;
            var now = Date.now();
            var d = new Date(now);
            var timeStr = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

            claimMasterLockNow();
            db.ref('foxStatuses/' + areaName).set({
                area: areaName,
                status: chosenColor,
                rawStatus: chosenColor,
                updatedAt: now,
                timeFormatted: timeStr,
                rawMessage: "Handmatig ingesteld door Admin"
            });
        });
    });

    var saveUserPwdBtn = document.getElementById('admin-save-user-password-btn');
    var userPwdInput = document.getElementById('admin-user-password-input');
    if (saveUserPwdBtn && userPwdInput) {
        saveUserPwdBtn.addEventListener('click', async function() {
            if (!isAdmin) return;
            var newPwd = userPwdInput.value.trim();
            if (!newPwd) {
                alert("Voer een geldig wachtwoord in voor de gebruikers.");
                return;
            }
            if (firebaseAuthConfig.adminPassword && newPwd === firebaseAuthConfig.adminPassword) {
                alert("Kies voor de gebruikers een ander wachtwoord dan het Admin-wachtwoord.");
                return;
            }

            var snap = await db.ref('authSettings').once('value');
            var cur = snap.val() || {};
            var nextVersion = (Number(cur.userSessionVersion) || 1) + 1;

            await db.ref('authSettings').update({
                userPassword: newPwd,
                userSessionVersion: nextVersion,
                updatedAt: Date.now()
            });

            await db.ref('liveUsers').remove();

            alert("Gebruikerswachtwoord gewijzigd naar '" + newPwd + "'. Alle ingelogde gebruikers zijn automatisch uitgelogd.");
        });
    }

    window.syncAdminFoxFilterCheckboxes();
}

window.syncAdminFoxFilterCheckboxes = function() {
    var checkboxes = document.querySelectorAll('.admin-fox-color-cb');
    checkboxes.forEach(function(cb) {
        var cKey = cb.getAttribute('data-color');
        cb.checked = (visibleFoxStatusColors[cKey] !== false);
    });

    var selects = document.querySelectorAll('.admin-manual-fox-status');
    selects.forEach(function(sel) {
        var aName = sel.getAttribute('data-area');
        if (currentFoxStatuses[aName] && currentFoxStatuses[aName].status) {
            sel.value = normalizeFoxStatusKey(currentFoxStatuses[aName].status);
        }
    });
};

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
        titleEl.innerText = "RD-Punt Bewerken";
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

    claimMasterLockNow();

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

/* --- ADMIN BEHEERACTIES (RD-PUNTEN, HUISJES & GEBRUIKERS) --- */
window.saveHouseVisitedWithTime = function(houseName, inputId) {
    if (!isAdmin) return;
    var safeKey = houseName.replace(/[.#$[\]]/g, '_');
    var inputEl = inputId ? document.getElementById(inputId) : null;
    var chosenTs = Date.now();

    if (inputEl && inputEl.value) {
        var parsed = new Date(inputEl.value).getTime();
        if (!isNaN(parsed)) {
            chosenTs = parsed;
        }
    }

    var updates = {};
    updates[safeKey] = chosenTs;

    claimMasterLockNow();
    db.ref('houseVisited').update(updates).then(function() {
        checkAreaRoundCompletion();
        window.calculateAndPublishMapState(true);
        map.closePopup();
    });
};

window.clearHouseVisited = function(houseName) {
    if (!isAdmin) return;
    var safeKey = houseName.replace(/[.#$[\]]/g, '_');
    var updates = {};
    updates[safeKey] = null;

    claimMasterLockNow();
    db.ref('houseVisited').update(updates).then(function() {
        window.calculateAndPublishMapState(true);
        map.closePopup();
    });
};

window.toggleHouseVisited = function(houseName) {
    if (!isAdmin) return;
    var safeKey = houseName.replace(/[.#$[\]]/g, '_');
    var current = !!houseVisitedStatus[safeKey];
    if (current) {
        window.clearHouseVisited(houseName);
    } else {
        window.saveHouseVisitedWithTime(houseName, 'house_dt_' + safeKey);
    }
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
        claimMasterLockNow();
        db.ref('rdPoints/' + key).remove().then(function() {
            window.calculateAndPublishMapState(true);
            map.closePopup();
        });
    }
};

window.clearRdPoints = function() {
    if (!isAdmin) return;
    var pinInput = prompt("Voer het Admin-wachtwoord in om de RD-lijnen te wissen:", "");
    var validAdminPwd = (typeof firebaseAuthConfig !== 'undefined' && firebaseAuthConfig.adminPassword)
        ? firebaseAuthConfig.adminPassword
        : "6546";

    if (pinInput === validAdminPwd) {
        walkingRouteCache = {};
        segmentDistanceCache = {};
        drivingRouteMetricsCache = {};
        areaCappedStatus = {};
        updateAdminSettingsPanelStatus();
        claimMasterLockNow();
        db.ref('rdPoints').remove().then(function() {
            db.ref('computedMapState').remove();
            alert("RD-punten succesvol gewist.");
        });
    } else if (pinInput !== null) {
        alert("Onjuist Admin-wachtwoord!");
    }
};

window.removeInactiveUser = function(userId, userName) {
    if (!isAdmin || !userId) return;
    db.ref('liveUsers/' + userId).remove().then(function() {
        map.closePopup();
    });
};