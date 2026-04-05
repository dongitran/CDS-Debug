/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getRendererScriptContent(): string {
  return `
    function renderInitial() {
      return \`
        <div class="step-header">
          <span class="step-badge">1/4</span>
          <span class="step-title">Select Projects Folder</span>
        </div>
        <div class="info-box">
          Choose the root folder that contains your client group folders
          (e.g. <code>~/Code/projects/</code>).
        </div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <button class="btn" id="btn-select-folder">Browse&hellip;</button>
      \`;
    }

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
          <span class="step-badge">2/4</span>
          <span class="step-title">CF Region</span>
        </div>
        <div class="info-box">Root: <code>\${escape(state.rootFolder)}</code></div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">Select Region</div>
        <div class="region-grid">
          \${regionCards}
          \${customCard}
        </div>
        \${customInput}
        <button class="btn" id="btn-login">Login to Cloud Foundry</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-initial">Back</button>
      \`;
    }

    function renderLoggingIn() {
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          Logging in&hellip;
        </div>
        <div class="radio-desc" style="text-align:center;margin-top:4px">\${escape(state.apiEndpoint)}</div>
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
          <span class="step-badge">3/4</span>
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
      const items = state.groupFolders.map(f => \`
        <label class="org-item \${f === state.selectedFolder ? 'selected' : ''}">
          <input type="radio" name="cf-folder" value="\${escape(f)}"
            \${f === state.selectedFolder ? 'checked' : ''} />
          <span class="org-item-name" title="\${escape(f)}">\${escape(f)}</span>
        </label>
      \`).join('');

      return \`
        <div class="step-header">
          <span class="step-badge">3/4</span>
          <span class="step-title">Select Local Folder</span>
        </div>
        <div class="info-box">Org: <code>\${escape(state.selectedOrg ?? '')}</code></div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">Local Group Folder</div>
        <div class="org-list">
          \${items || \`<div class="org-list-empty">No folders found.</div>\`}
        </div>
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
      \`;
    }

    function renderActiveCard(appName) {
      const session = state.activeSessions[appName];
      const appInfo = state.apps.find(a => a.name === appName);
      const appUrl = (appInfo && appInfo.urls && appInfo.urls.length > 0) ? 'https://' + appInfo.urls[0] : '';

      let icon = '';
      let text = '';
      if (session.status === 'TUNNELING') {
        icon = '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>';
        text = LOADING_MESSAGES[session.msgPhase] || "Connecting...";
      } else if (session.status === 'ATTACHED') {
        icon = '<span style="color:var(--vscode-testing-iconPassed);margin-right:6px">&#9679;</span>';
        text = 'Debugger Attached';
      } else if (session.status === 'ERROR') {
        icon = '<span style="color:var(--vscode-testing-iconFailed);margin-right:6px">&#10006;</span>';
        text = session.message || 'Connection Error';
      }

      const openBtn = (session.status === 'ATTACHED' && appUrl) ? \`
        <button class="active-open-btn" data-open-url="\${escape(appUrl)}"
          title="Open App in Browser" aria-label="Open \${escape(appName)} in browser">
          &#8599; Open App
        </button>
      \` : '';

      return \`
        <div class="active-card" data-app-name="\${escape(appName)}">
          <div class="active-card-main">
            <div class="active-card-title" title="\${escape(appName)}">\${escape(appName)}</div>
            <div class="active-card-status">
              \${icon}
              <span class="status-text-anim" key="\${session.msgPhase}">\${escape(text)}</span>
            </div>
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
      return \`
        <div class="section-label" style="display:flex;align-items:center;gap:6px">
          <span style="color:var(--vscode-testing-iconPassed)">&#9679;</span> Active Sessions
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
          \${activeAppNames.map(renderActiveCard).join('')}
        </div>
        <div class="divider"></div>
      \`;
    }

    function refreshActiveSessionsPanel() {
      const panel = document.getElementById('active-sessions-panel');
      if (!panel) return;
      panel.innerHTML = renderActiveSessionsContent();
    }

    function refreshAppListSection() {
      const filtered = state.apps.filter(app =>
        !state.searchQuery || app.name.toLowerCase().includes(state.searchQuery.toLowerCase())
      );
      const started = filtered.filter(a => a.state === 'started');
      const stopped = filtered.filter(a => a.state === 'stopped');
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
        footerInfo.textContent = selectedCount + ' service' + (selectedCount !== 1 ? 's' : '') + ' selected';
      }
      const startBtn = document.getElementById('btn-start-debug');
      if (startBtn) {
        if (selectedCount === 0) startBtn.setAttribute('disabled', '');
        else startBtn.removeAttribute('disabled');
      }
    }

    function updateActiveCardStatusOnly(appName) {
      const session = state.activeSessions[appName];
      if (!session || session.status !== 'TUNNELING') return;
      const cards = document.querySelectorAll('[data-app-name]');
      let card = null;
      for (let i = 0; i < cards.length; i++) {
        if (cards[i].dataset.appName === appName) { card = cards[i]; break; }
      }
      if (!card) return;
      const statusEl = card.querySelector('.active-card-status');
      if (!statusEl) return;
      const text = LOADING_MESSAGES[session.msgPhase] || "Connecting...";
      statusEl.innerHTML =
        '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>' +
        '<span class="status-text-anim">' + escape(text) + '</span>';
    }

    function renderAppRow(app) {
      const isActive = !!state.activeSessions[app.name];
      const isDisabled = app.state === 'stopped' || isActive;
      const isChecked = state.selectedApps.has(app.name) && !isActive;
      return \`
        <label class="app-row \${isDisabled ? 'stopped' : ''}">
          <input type="checkbox" data-app="\${escape(app.name)}"
            aria-label="Select \${escape(app.name)} for debug"
            \${isChecked ? 'checked' : ''}
            \${isDisabled ? 'disabled' : ''} />
          <span class="app-name" title="\${escape(app.name)}">\${escape(app.name)}</span>
          <span class="badge badge-\${app.state}">\${app.state}</span>
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
      const started = filtered.filter(a => a.state === 'started');
      const stopped = filtered.filter(a => a.state === 'stopped');

      const selectedCount = [...state.selectedApps].filter(n =>
        state.apps.find(a => a.name === n && a.state === 'started') && !state.activeSessions[n]
      ).length;

      const resetBtn = state.error ? \`
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-reset-login" style="color:var(--vscode-errorForeground)">
          &#8634; Logout / Re-login
        </button>
      \` : '';

      return \`
        <div class="step-header">
          <span class="step-badge">4/4</span>
          <span class="step-title">Debug Launcher</span>
          <button class="gear-btn" id="btn-gear" title="Settings" aria-label="Open settings">&#9881;</button>
        </div>
        <div class="sr-only" aria-live="polite">\${escape(buildLiveStatus())}</div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}

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
        <div style="height:8px"></div>

        <div class="app-list">
          \${renderAppSection(started, 'Started')}
          \${renderAppSection(stopped, 'Stopped')}
          \${filtered.length === 0 ? '<div style="text-align:center;padding:16px;color:var(--vscode-descriptionForeground)">No apps found</div>' : ''}
        </div>

        <div class="footer">
          <div class="footer-info">\${selectedCount} service\${selectedCount !== 1 ? 's' : ''} selected</div>
          <button class="btn" id="btn-start-debug" aria-label="Start selected debug sessions"
            \${selectedCount === 0 ? 'disabled' : ''}>
            &#9654; Start Debug Sessions
          </button>
          <div style="height:6px"></div>
          <button class="btn btn-secondary" id="btn-remap">&#8592; Change Mapping</button>
          \${resetBtn}
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
      return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
    }

    function renderSettings() {
      const s = state.syncStatus;
      const progressText = s.isRunning
        ? (s.currentOrg
          ? 'Scanning ' + escape(s.currentRegion || '') + ' / ' + escape(s.currentOrg) + ' (' + s.done + '/' + s.total + ')...'
          : s.currentRegion
            ? 'Logging into ' + escape(s.currentRegion) + ' (' + s.done + '/' + s.total + ')...'
            : 'Initializing...')
        : '';

      return \`
        <div class="step-header">
          <span class="step-title">Settings</span>
        </div>

        <div class="section-label">Background Cache Sync</div>
        <div class="info-box" style="margin-bottom:10px">
          CF apps are cached every 4 hours across all regions.
          When a cache hit is found (&lt;4h old), the app list loads instantly.
        </div>

        \${s.isRunning ? \`
          <div class="sync-status-row running">
            <span class="spinner" style="width:11px;height:11px;border-width:1.5px;margin-right:6px"></span>
            <span>\${escape(progressText)}</span>
          </div>
        \` : \`
          <div class="sync-status-row">
            <span style="color:var(--vscode-testing-iconPassed);margin-right:4px">&#9679;</span>
            <span>Last sync: <strong>\${escape(formatSyncTime(s.lastCompletedAt))}</strong></span>
          </div>
        \`}

        <div style="height:10px"></div>
        <button class="btn" id="btn-trigger-sync" \${s.isRunning ? 'disabled' : ''}>
          \${s.isRunning ? '&#8987; Syncing\u2026' : '&#8635; Sync Now'}
        </button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-settings">&#8592; Back to Launcher</button>
      \`;
    }

    function attachSettingsListeners() {
      const $ = id => document.getElementById(id);

      $('btn-gear')?.addEventListener('click', () => {
        state.screen = SCREENS.SETTINGS;
        vscode.postMessage({ type: 'GET_SYNC_STATUS' });
        render();
      });

      $('btn-back-settings')?.addEventListener('click', () => {
        state.screen = SCREENS.READY;
        state.error = null;
        render();
      });

      $('btn-trigger-sync')?.addEventListener('click', () => {
        if (state.syncStatus.isRunning) return;
        vscode.postMessage({ type: 'TRIGGER_SYNC' });
        // Optimistically mark as running so the button disables immediately.
        state.syncStatus = { ...state.syncStatus, isRunning: true };
        render();
      });
    }
  `;
}
