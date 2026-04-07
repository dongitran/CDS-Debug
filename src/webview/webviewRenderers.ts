/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getRendererScriptContent(): string {
  return `
    function renderRegion() {
      const regionCards = CF_REGIONS.map(r => \`
        <label class="region-card \${!state.useCustomEndpoint && state.selectedRegion === r.code ? 'selected' : ''}">
          <input type="radio" name="cf-region" value="\${escape(r.code)}"
            \${!state.useCustomEndpoint && state.selectedRegion === r.code ? 'checked' : ''} />
          <span class="region-code">\${escape(r.code)}</span>
          <span class="region-name">\${escape(r.name)}</span>
        </label>
      \`).join('');

      const customCard = \`
        <label class="region-card region-card-custom \${state.useCustomEndpoint ? 'selected' : ''}">
          <input type="radio" name="cf-region" value="custom"
            \${state.useCustomEndpoint ? 'checked' : ''} />
          <span class="region-code" style="font-size:11px">Custom endpoint</span>
        </label>
      \`;

      const customInput = state.useCustomEndpoint ? \`
        <input class="input" id="api-endpoint-custom"
          placeholder="https://api.cf.<region>.hana.ondemand.com"
          value="\${escape(state.apiEndpoint)}" />
        <div class="radio-desc" style="margin-top:4px">Enter your full CF API URL</div>
        <div style="height:8px"></div>
      \` : \`
        <div class="radio-desc" style="margin-bottom:8px">
          Endpoint: <code>https://api.cf.\${escape(state.selectedRegion)}.hana.ondemand.com</code>
        </div>
      \`;

      return \`
        <div class="step-header">
          <span class="step-badge">1/3</span>
          <span class="step-title">CF Region</span>
        </div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">Select Region</div>
        <div class="region-grid">
          \${regionCards}
          \${customCard}
        </div>
        \${customInput}
        <button class="btn" id="btn-login">Login to Cloud Foundry</button>
      \`;
    }

    function renderLoggingIn() {
      const cancelBtn = state.isReconnecting ? '' : \`
        <div style="height:16px"></div>
        <button class="btn btn-secondary" id="btn-cancel-login">&#8592; Cancel</button>
      \`;
      const headingText = state.isReconnecting
        ? 'Session expired. Reconnecting\u2026'
        : 'Logging in\u2026';
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          \${headingText}
        </div>
        <div class="radio-desc" style="text-align:center;margin-top:4px">\${escape(state.apiEndpoint)}</div>
        \${cancelBtn}
      \`;
    }

    function renderSelectOrg() {
      const items = state.orgs.map(org => \`
        <label class="org-item \${org === state.selectedOrg ? 'selected' : ''}">
          <input type="radio" name="cf-org" value="\${escape(org)}"
            \${org === state.selectedOrg ? 'checked' : ''} />
          <span class="org-item-name" title="\${escape(org)}">\${escape(org)}</span>
        </label>
      \`).join('');

      return \`
        <div class="step-header">
          <span class="step-badge">2/3</span>
          <span class="step-title">Select CF Org</span>
        </div>
        <div class="info-box">Choose the Cloud Foundry org you want to debug.</div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">CF Org</div>
        <div class="org-list">
          \${items || \`<div class="org-list-empty">No orgs found.</div>\`}
        </div>
        <div style="height:10px"></div>
        <button class="btn" id="btn-next-org" \${!state.selectedOrg ? 'disabled' : ''}>Next &rarr;</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-region">Back</button>
      \`;
    }

    function renderSelectFolder() {
      const folderDisplay = state.selectedFolder
        ? \`<div class="info-box" style="word-break:break-all"><code>\${escape(state.selectedFolder)}</code></div>\`
        : \`<div class="radio-desc" style="margin-bottom:8px">No folder selected yet.</div>\`;

      return \`
        <div class="step-header">
          <span class="step-badge">3/3</span>
          <span class="step-title">Select Local Folder</span>
        </div>
        <div class="info-box">Org: <code>\${escape(state.selectedOrg ?? '')}</code></div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">Local Group Folder</div>
        \${folderDisplay}
        <button class="btn btn-secondary" id="btn-browse-folder">Browse&hellip;</button>
        <div style="height:10px"></div>
        <button class="btn" id="btn-save-mapping" \${!state.selectedFolder ? 'disabled' : ''}>Save &amp; Continue</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-select-org">Back</button>
      \`;
    }

    function renderLoadingApps() {
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          Loading apps for <strong>\${escape(state.selectedOrg)}</strong>&hellip;
        </div>
        <div style="height:16px"></div>
        <button class="btn btn-secondary" id="btn-cancel-load-apps">&#8592; Cancel</button>
      \`;
    }

    function getStatusInnerHtml(session) {
      if (session.status === 'TUNNELING') {
        const text = LOADING_MESSAGES[session.msgPhase] || 'Connecting...';
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">' + escape(text) + '</span>';
      }
      if (session.status === 'ATTACHED') {
        return '<span style="color:var(--vscode-testing-iconPassed);margin-right:6px">&#9679;</span>'
          + '<span class="status-text-anim">Debugger Attached</span>';
      }
      if (session.status === 'ERROR') {
        return '<span style="color:var(--vscode-testing-iconFailed);margin-right:6px">&#10006;</span>'
          + '<span class="status-text-anim">' + escape(session.message || 'Connection Error') + '</span>';
      }
      return '';
    }

    function normalizeUrl(rawUrl) {
      if (!rawUrl) return '';
      return rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : 'https://' + rawUrl;
    }

    function renderActiveCard(appName) {
      const session = state.activeSessions[appName];
      const appInfo = state.apps.find(a => a.name === appName);
      const rawUrl = appInfo && appInfo.urls && appInfo.urls.length > 0 ? appInfo.urls[0] : '';
      const appUrl = normalizeUrl(rawUrl);
      const portText = session.port ? '<span class="active-card-port">:' + session.port + '</span>' : '';

      const openBtn = (session.status === 'ATTACHED' && appUrl) ? \`
        <button class="active-open-btn" data-open-url="\${escape(appUrl)}"
          title="Open App in Browser" aria-label="Open \${escape(appName)} in browser">
          &#8599; Open
        </button>
      \` : '';

      return \`
        <div class="active-card" data-app-name="\${escape(appName)}">
          <div class="active-card-main">
            <div class="active-card-title" title="\${escape(appName)}">\${escape(appName)}\${portText}</div>
            <div class="active-card-status">\${getStatusInnerHtml(session)}</div>
          </div>
          \${openBtn}
          <button class="active-stop-btn" data-stop-app="\${escape(appName)}"
            title="Stop Debug Session" aria-label="Stop debug for \${escape(appName)}">&#9632;</button>
        </div>
      \`;
    }

    function renderActiveSessionsContent() {
      const activeAppNames = Object.keys(state.activeSessions);
      if (activeAppNames.length === 0) return '';
      const stopAllBtn = activeAppNames.length > 1 ? \`
        <button class="stop-all-btn" id="btn-stop-all-sessions" aria-label="Stop all debug sessions">
          &#9632; Stop All Sessions (\${activeAppNames.length})
        </button>
      \` : '';
      return \`
        <div class="section-label" style="display:flex;align-items:center;gap:6px">
          <span style="color:var(--vscode-testing-iconPassed)">&#9679;</span> Active Sessions
        </div>
        \${stopAllBtn}
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
          \${activeAppNames.map(renderActiveCard).join('')}
        </div>
        <div class="divider"></div>
      \`;
    }

    function refreshActiveSessionsPanel() {
      const panel = document.getElementById('active-sessions-panel');
      if (!panel) return;

      const activeAppNames = Object.keys(state.activeSessions);

      if (activeAppNames.length === 0) {
        panel.innerHTML = '';
        return;
      }

      const existingCards = Array.from(panel.querySelectorAll('[data-app-name]'));
      const existingNames = existingCards.map(function(c) { return c.dataset.appName; });
      const sameSet = activeAppNames.length === existingNames.length
        && activeAppNames.every(function(n) { return existingNames.indexOf(n) !== -1; });

      if (!sameSet) {
        // Session added or removed — full rebuild with slide-in animation
        panel.innerHTML = renderActiveSessionsContent();
        return;
      }

      // Same set of sessions — update only the status part of each card (no animation)
      for (let i = 0; i < activeAppNames.length; i++) {
        const appName = activeAppNames[i];
        const session = state.activeSessions[appName];
        let card = null;
        for (let j = 0; j < existingCards.length; j++) {
          if (existingCards[j].dataset.appName === appName) { card = existingCards[j]; break; }
        }
        if (!card) continue;

        const statusEl = card.querySelector('.active-card-status');
        if (statusEl) {
          const newHtml = getStatusInnerHtml(session);
          if (statusEl.innerHTML !== newHtml) statusEl.innerHTML = newHtml;
        }

        // Handle open button visibility for ATTACHED state
        const appInfo = state.apps.find(function(a) { return a.name === appName; });
        const appUrl = normalizeUrl(appInfo && appInfo.urls && appInfo.urls.length > 0 ? appInfo.urls[0] : '');
        const existingOpenBtn = card.querySelector('[data-open-url]');
        const stopBtn = card.querySelector('[data-stop-app]');

        if (session.status === 'ATTACHED' && appUrl && !existingOpenBtn && stopBtn) {
          const tmp = document.createElement('div');
          tmp.innerHTML = '<button class="active-open-btn" data-open-url="' + escape(appUrl) + '"'
            + ' title="Open App in Browser" aria-label="Open ' + escape(appName) + ' in browser">'
            + '&#8599; Open App</button>';
          stopBtn.parentNode.insertBefore(tmp.firstChild, stopBtn);
        } else if (session.status !== 'ATTACHED' && existingOpenBtn) {
          existingOpenBtn.remove();
        }
      }
    }

    function refreshAppListSection() {
      const filtered = state.apps.filter(app =>
        !state.searchQuery || app.name.toLowerCase().includes(state.searchQuery.toLowerCase())
      );
      const started = filtered.filter(a => a.state === 'started').sort((a, b) => a.name.localeCompare(b.name));
      const stopped = filtered.filter(a => a.state === 'stopped').sort((a, b) => a.name.localeCompare(b.name));
      const startedNonActive = state.apps.filter(a => a.state === 'started' && !state.activeSessions[a.name]);
      const selectedCount = [...state.selectedApps].filter(n =>
        state.apps.find(a => a.name === n && a.state === 'started') && !state.activeSessions[n]
      ).length;

      const appList = document.querySelector('.app-list');
      if (appList) {
        let listHtml = renderAppSection(started, 'Started') + renderAppSection(stopped, 'Stopped');
        if (filtered.length === 0) {
          listHtml = '<div style="text-align:center;padding:16px;color:var(--vscode-descriptionForeground)">No apps found</div>';
        }
        appList.innerHTML = listHtml;
      }

      const footerInfo = document.querySelector('.footer-info');
      if (footerInfo) {
        const totalStarted = startedNonActive.length;
        footerInfo.textContent = totalStarted > 0
          ? selectedCount + ' / ' + totalStarted + ' selected'
          : 'No started apps';
      }
      const startBtn = document.getElementById('btn-start-debug');
      if (startBtn) {
        if (selectedCount === 0) startBtn.setAttribute('disabled', '');
        else startBtn.removeAttribute('disabled');
      }

      // Sync select-all checkbox state
      const selectAllChk = document.getElementById('chk-select-all');
      if (selectAllChk) {
        const selectableStarted = filtered.filter(a => a.state === 'started' && !state.activeSessions[a.name]);
        const allSelected = selectableStarted.length > 0 && selectableStarted.every(a => state.selectedApps.has(a.name));
        selectAllChk.checked = allSelected;
        const label = selectAllChk.closest('label');
        if (label) {
          const span = label.querySelector('span');
          if (span) span.textContent = (allSelected ? 'Deselect all' : 'Select all started') + ' (' + startedNonActive.length + ')';
        }
      }
    }

    function updateActiveCardStatusOnly(appName) {
      const session = state.activeSessions[appName];
      if (!session) return;
      const cards = document.querySelectorAll('[data-app-name]');
      let card = null;
      for (let i = 0; i < cards.length; i++) {
        if (cards[i].dataset.appName === appName) { card = cards[i]; break; }
      }
      if (!card) return;
      const statusEl = card.querySelector('.active-card-status');
      if (!statusEl) return;
      statusEl.innerHTML = getStatusInnerHtml(session);
    }

    function renderAppRow(app) {
      const isActive = !!state.activeSessions[app.name];
      const isStopped = app.state === 'stopped';
      const isDisabled = isStopped || isActive;
      const isChecked = state.selectedApps.has(app.name) && !isActive;
      const rowClass = isActive ? 'in-debug' : (isStopped ? 'stopped' : '');
      const badge = isActive
        ? \`<span class="badge badge-debug">debugging</span>\`
        : \`<span class="badge badge-\${app.state}">\${app.state}</span>\`;
      return \`
        <label class="app-row \${rowClass}">
          <input type="checkbox" data-app="\${escape(app.name)}"
            aria-label="Select \${escape(app.name)} for debug"
            \${isChecked ? 'checked' : ''}
            \${isDisabled ? 'disabled' : ''} />
          <span class="app-name" title="\${escape(app.name)}">\${escape(app.name)}</span>
          \${badge}
        </label>
      \`;
    }

    function renderAppSection(apps, label) {
      if (apps.length === 0) return '';
      return \`
        <div class="section-label">\${label}</div>
        \${apps.map(renderAppRow).join('')}
      \`;
    }

    function renderReady() {
      const filtered = state.apps.filter(app =>
        !state.searchQuery || app.name.toLowerCase().includes(state.searchQuery.toLowerCase())
      );
      const started = filtered.filter(a => a.state === 'started').sort((a, b) => a.name.localeCompare(b.name));
      const stopped = filtered.filter(a => a.state === 'stopped').sort((a, b) => a.name.localeCompare(b.name));

      const startedNonActive = state.apps.filter(a => a.state === 'started' && !state.activeSessions[a.name]);
      const selectableStarted = filtered.filter(a => a.state === 'started' && !state.activeSessions[a.name]);
      const selectedCount = [...state.selectedApps].filter(n =>
        state.apps.find(a => a.name === n && a.state === 'started') && !state.activeSessions[n]
      ).length;
      const allSelected = selectableStarted.length > 0 && selectableStarted.every(a => state.selectedApps.has(a.name));
      const selectAllRow = startedNonActive.length > 0 ? \`
        <label class="select-all-row">
          <input type="checkbox" id="chk-select-all" \${allSelected ? 'checked' : ''} />
          <span>\${allSelected ? 'Deselect all' : 'Select all started'} (\${startedNonActive.length})</span>
        </label>
      \` : '';

      const totalStarted = startedNonActive.length;
      const countLabel = totalStarted > 0
        ? selectedCount + ' / ' + totalStarted + ' selected'
        : 'No started apps';

      return \`
        <div class="step-header">
          <span class="step-title">Debug Launcher</span>
          <button class="gear-btn" id="btn-refresh-apps" title="Refresh app list" aria-label="Refresh apps" style="font-size:13px">&#8635;</button>
          <button class="gear-btn" id="btn-gear" title="Settings" aria-label="Open settings">&#9881;</button>
        </div>
        <div class="sr-only" aria-live="polite">\${escape(buildLiveStatus())}</div>
        \${state.error ? \`
          <div class="error-box">\${escape(state.error)}</div>
          <div style="height:6px"></div>
          <button class="btn btn-secondary" id="btn-retry-apps" style="margin-bottom:4px">&#8635; Retry</button>
        \` : ''}

        <div id="active-sessions-panel">\${renderActiveSessionsContent()}</div>

        <div class="section-label">Cloud Foundry</div>
        <div class="cf-info-box">
          <div class="cf-info-row">
            <span class="cf-info-label">Region</span>
            <span class="cf-info-value" title="\${escape(state.apiEndpoint)}">\${escape(getRegionDisplay())}</span>
          </div>
          <div class="cf-info-row">
            <span class="cf-info-label">Org</span>
            <span class="cf-info-value" title="\${escape(state.selectedOrg ?? '')}">\${escape(state.selectedOrg ?? '')}</span>
          </div>
        </div>
        <div style="height:8px"></div>
        <input class="input" id="search-input" placeholder="Search apps&hellip;"
          aria-label="Search apps" value="\${escape(state.searchQuery)}" />
        <div style="height:4px"></div>
        \${selectAllRow}

        <div class="app-list">
          \${renderAppSection(started, 'Started')}
          \${renderAppSection(stopped, 'Stopped')}
          \${filtered.length === 0 ? '<div style="text-align:center;padding:16px;color:var(--vscode-descriptionForeground)">No apps found</div>' : ''}
        </div>

        <div class="footer">
          <div class="footer-info">\${countLabel}</div>
          <button class="btn" id="btn-start-debug" aria-label="Start selected debug sessions"
            \${selectedCount === 0 ? 'disabled' : ''}>
            &#9654; Start Debug Sessions
          </button>
          <div style="height:6px"></div>
          <button class="btn btn-secondary" id="btn-remap">&#8592; Change Mapping</button>
        </div>
      \`;
    }

    // === SETTINGS SCREEN ===

    function formatSyncTime(ts) {
      if (!ts) return 'Never';
      const mins = Math.round((Date.now() - ts) / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
      const days = Math.round(hrs / 24);
      return days + ' day' + (days === 1 ? '' : 's') + ' ago';
    }

    function renderSettings() {
      const s = state.syncStatus;
      const c = state.cacheConfig;
      const pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
      const progressText = s.isRunning
        ? (s.currentOrg
          ? 'Scanning ' + escape(s.currentRegion || '') + ' / ' + escape(s.currentOrg) + ' (' + s.done + '/' + s.total + ' \u00b7 ' + pct + '%)'
          : s.currentRegion
            ? 'Logging into ' + escape(s.currentRegion) + ' (' + s.done + '/' + s.total + ' \u00b7 ' + pct + '%)'
            : 'Initializing...')
        : '';

      const intervalOptions = [1, 2, 4, 8].map(function(h) {
        const sel = c.intervalHours === h ? ' selected' : '';
        const label = h + ' hour' + (h === 1 ? '' : 's') + (h === 4 ? ' (default)' : '');
        return '<option value="' + h + '"' + sel + '>' + label + '</option>';
      }).join('');

      let statusRow;
      if (!c.enabled && s.isRunning) {
        // Brief window between user saving "disabled" and doSync() reaching its next
        // shouldAbort() checkpoint. Show a spinner so the user knows it's stopping.
        statusRow = '<div class="sync-status-row running"><span class="spinner" style="width:11px;height:11px;border-width:1.5px;margin-right:6px"></span><span>Stopping sync\u2026</span></div>';
      } else if (!c.enabled) {
        statusRow = '<div class="sync-status-row"><span style="color:var(--vscode-descriptionForeground);margin-right:4px">&#9632;</span><span>Caching disabled</span></div>';
      } else if (s.isRunning) {
        statusRow = \`
          <div class="sync-status-row running">
            <span class="spinner" style="width:11px;height:11px;border-width:1.5px;margin-right:6px"></span>
            <span>\${escape(progressText)}</span>
          </div>
          <div class="progress-bar-wrap">
            <div class="progress-bar-fill" style="width:\${pct}%"></div>
          </div>
        \`;
      } else {
        statusRow = \`
          <div class="sync-status-row">
            <span style="color:var(--vscode-testing-iconPassed);margin-right:4px">&#9679;</span>
            <span>Last sync: <strong>\${escape(formatSyncTime(s.lastCompletedAt))}</strong></span>
          </div>
        \`;
      }

      return \`
        <div class="step-header">
          <span class="step-title">Settings</span>
        </div>

        <div class="section-label">Debug Behavior</div>

        <label class="pref-row" for="chk-open-browser">
          <div class="pref-row-content">
            <span class="pref-row-title">&#127758;&nbsp;Open browser on debugger attach
              <span class="pref-state-badge \${state.debugPrefs.openBrowserOnAttach ? 'pref-state-on' : 'pref-state-off'}">
                \${state.debugPrefs.openBrowserOnAttach ? 'enabled' : 'off by default'}
              </span>
            </span>
            <span class="pref-row-desc">When enabled, automatically opens the app URL in your browser once the debugger attaches. Off by default &mdash; use the &ldquo;&#8599;&nbsp;Open&rdquo; button on each active session card for manual control.</span>
          </div>
          <div class="toggle-switch \${state.debugPrefs.openBrowserOnAttach ? 'on' : ''}">
            <input type="checkbox" id="chk-open-browser" \${state.debugPrefs.openBrowserOnAttach ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </div>
        </label>

        <div style="height:4px"></div>

        <label class="pref-row" for="chk-branch-prep">
          <div class="pref-row-content">
            <span class="pref-row-title">Branch auto-checkout <span class="beta-badge">experimental</span></span>
            <span class="pref-row-desc">Before starting a debug session, automatically stash local changes, check out the branch mapped to the CF org, then run <code>pnpm install</code> and <code>pnpm build</code>. Configure branch mappings in <code>cap-debug-config.json</code>.</span>
          </div>
          <div class="toggle-switch \${state.debugPrefs.enableBranchPrep ? 'on' : ''}">
            <input type="checkbox" id="chk-branch-prep" \${state.debugPrefs.enableBranchPrep ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </div>
        </label>

        <div class="divider" style="margin:12px 0"></div>

        <div class="section-label">App Cache</div>

        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px;font-size:13px">
          <input type="checkbox" id="chk-cache-enabled" \${c.enabled ? 'checked' : ''} />
          <span>Enable background sync</span>
        </label>

        <div class="radio-desc" style="margin-bottom:4px">Sync interval</div>
        <select class="select" id="select-interval" \${!c.enabled ? 'disabled' : ''}>
          \${intervalOptions}
        </select>

        <div style="height:10px"></div>
        <button class="btn" id="btn-save-cache-settings">Save Settings</button>

        <div class="divider" style="margin:12px 0"></div>

        \${statusRow}
        <div style="height:10px"></div>
        <button class="btn btn-secondary" id="btn-trigger-sync" \${!c.enabled || s.isRunning ? 'disabled' : ''}>
          \${c.enabled && s.isRunning ? '&#8987; Syncing\u2026' : '&#8635; Sync Now'}
        </button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-settings">&#8592; Back to Launcher</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-logout-settings"
          style="color:var(--vscode-errorForeground)">&#8634; Logout / Change Region</button>
      \`;
    }

    // === BRANCH PREP SCREEN ===

    function getBranchPrepStepInfo(service) {
      var step = service.step;
      if (step === 'done') {
        return { icon: '<span class="prep-icon prep-icon-ok">&#10003;</span>', text: 'Ready' };
      }
      if (step === 'skipped') {
        return { icon: '<span class="prep-icon prep-icon-skip">&#8212;</span>', text: escape(service.message || 'No branch change needed') };
      }
      if (step === 'error') {
        return { icon: '<span class="prep-icon prep-icon-err">&#10007;</span>', text: escape(service.message || 'Error') };
      }
      var text = 'Preparing\u2026';
      if (step === 'stashing') text = 'Stashing uncommitted changes\u2026';
      else if (step === 'checking-out') text = 'Checking out branch ' + escape(service.targetBranch) + '\u2026';
      else if (step === 'installing') text = 'Running pnpm install\u2026';
      else if (step === 'building') text = 'Running pnpm build\u2026';
      return {
        icon: '<span class="spinner" style="width:11px;height:11px;border-width:1.5px"></span>',
        text: text,
      };
    }

    function renderPreparingBranches() {
      var services = state.branchPrepServices;
      var terminalSteps = ['done', 'skipped', 'error'];
      var allDone = services.length > 0 && services.every(function(s) { return terminalSteps.indexOf(s.step) !== -1; });
      var hasError = services.some(function(s) { return s.step === 'error'; });

      var rows = services.map(function(s) {
        var info = getBranchPrepStepInfo(s);
        var branchBadge = \`<span class="branch-badge">
          <span style="font-size:10px;margin-right:3px">&#x2387;</span>\${escape(s.targetBranch)}
        </span>\`;
        return \`
          <div class="prep-row">
            <div class="prep-row-top">
              <span class="prep-name" title="\${escape(s.appName)}">\${escape(s.appName)}</span>
              \${branchBadge}
            </div>
            <div class="prep-row-status">
              \${info.icon}
              <span class="prep-status-text">\${info.text}</span>
            </div>
          </div>
        \`;
      }).join('');

      var statusBlock;
      if (allDone && !hasError) {
        statusBlock = \`<div class="info-box" style="display:flex;align-items:center;gap:6px">
          <span class="spinner" style="width:11px;height:11px;border-width:1.5px"></span>
          <span>Starting debug sessions\u2026</span>
        </div>\`;
      } else if (allDone && hasError) {
        statusBlock = \`<div class="info-box" style="color:var(--vscode-descriptionForeground)">
          Some services failed. Debug will start for successful services.
        </div>\`;
      } else {
        statusBlock = \`<div class="info-box">Preparing branch environment for debugging\u2026</div>\`;
      }

      return \`
        <div class="step-header">
          <span class="step-title">Preparing Branches</span>
        </div>
        \${statusBlock}
        <div class="prep-list">
          \${rows || '<div class="org-list-empty">No services to prepare.</div>'}
        </div>
      \`;
    }

    function attachSettingsListeners() {
      const $ = id => document.getElementById(id);

      $('btn-gear')?.addEventListener('click', () => {
        state.screen = SCREENS.SETTINGS;
        vscode.postMessage({ type: 'GET_SYNC_STATUS' });
        vscode.postMessage({ type: 'GET_CACHE_CONFIG' });
        vscode.postMessage({ type: 'GET_DEBUG_PREFS' });
        render();
      });

      $('chk-open-browser')?.addEventListener('change', function(e) {
        const openBrowserOnAttach = !!e.target.checked;
        state.debugPrefs = { ...state.debugPrefs, openBrowserOnAttach };
        var toggle = $('chk-open-browser')?.closest('.toggle-switch');
        if (toggle) toggle.classList.toggle('on', openBrowserOnAttach);
        // Update badge text and state class in-place to avoid a full render()
        var badge = $('chk-open-browser')?.closest('.pref-row')?.querySelector('.pref-state-badge');
        if (badge) {
          badge.textContent = openBrowserOnAttach ? 'enabled' : 'off by default';
          badge.classList.toggle('pref-state-on', openBrowserOnAttach);
          badge.classList.toggle('pref-state-off', !openBrowserOnAttach);
        }
        vscode.postMessage({ type: 'SAVE_DEBUG_PREFS', payload: state.debugPrefs });
      });

      $('chk-branch-prep')?.addEventListener('change', function(e) {
        const enableBranchPrep = !!e.target.checked;
        state.debugPrefs = { ...state.debugPrefs, enableBranchPrep };
        var toggle = $('chk-branch-prep')?.closest('.toggle-switch');
        if (toggle) toggle.classList.toggle('on', enableBranchPrep);
        vscode.postMessage({ type: 'SAVE_DEBUG_PREFS', payload: state.debugPrefs });
      });

      $('btn-back-settings')?.addEventListener('click', () => {
        state.screen = SCREENS.READY;
        state.error = null;
        render();
      });

      $('btn-logout-settings')?.addEventListener('click', () => {
        state.error = null;
        state.screen = SCREENS.REGION;
        render();
        vscode.postMessage({ type: 'RESET_LOGIN' });
      });

      $('chk-cache-enabled')?.addEventListener('change', function(e) {
        const selectEl = document.getElementById('select-interval');
        if (selectEl) selectEl.disabled = !e.target.checked;
      });

      $('btn-save-cache-settings')?.addEventListener('click', () => {
        const enabled = !!document.getElementById('chk-cache-enabled')?.checked;
        const selectEl = document.getElementById('select-interval');
        const intervalHours = parseInt(selectEl?.value || '4', 10);
        vscode.postMessage({ type: 'SAVE_CACHE_CONFIG', payload: { enabled, intervalHours } });
        // Optimistic update so the status row reflects the new enabled state immediately.
        state.cacheConfig = { enabled, intervalHours };
        render();
      });

      $('btn-trigger-sync')?.addEventListener('click', () => {
        if (state.syncStatus.isRunning || !state.cacheConfig.enabled) return;
        vscode.postMessage({ type: 'TRIGGER_SYNC' });
        // Optimistically mark as running so the button disables immediately.
        state.syncStatus = { ...state.syncStatus, isRunning: true };
        render();
      });
    }
  `;
}
