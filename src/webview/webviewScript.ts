/**
 * Client-side JavaScript for the CDS Debug Launcher webview.
 * Runs in the VS Code webview browser context — no ES module imports allowed.
 * Sections: CONSTANTS → STATE → UTILS → RENDERERS → LISTENERS → MESSAGE HANDLER → INIT
 */
export function getScript(nonce: string): string {
  return `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // === CONSTANTS ===

    const SCREENS = {
      INITIAL: 'initial',
      REGION: 'region',
      LOGGING_IN: 'logging-in',
      SELECT_ORG: 'select-org',
      SELECT_FOLDER: 'select-folder',
      LOADING_APPS: 'loading-apps',
      READY: 'ready',
    };

    const CF_REGIONS = [
      { code: 'us10', name: 'US East (VA)' },
      { code: 'us20', name: 'US West (WA)' },
      { code: 'eu10', name: 'Europe (Frankfurt)' },
      { code: 'eu20', name: 'Europe (Amsterdam)' },
      { code: 'ap10', name: 'Australia (Sydney)' },
      { code: 'ap11', name: 'Singapore' },
      { code: 'br10', name: 'Brazil (São Paulo)' },
      { code: 'ca10', name: 'Canada (Montreal)' },
    ];

    const LOADING_MESSAGES = [
      "Opening SSH tunnel...",
      "Mapping local ports...",
      "Waiting for trace route...",
      "Establishing connection..."
    ];

    // === STATE ===

    let state = {
      screen: SCREENS.INITIAL,
      rootFolder: null,
      groupFolders: [],
      apiEndpoint: '',
      selectedRegion: 'eu10',
      useCustomEndpoint: false,
      orgs: [],
      mappings: [],
      selectedOrg: null,
      selectedFolder: null,
      apps: [],
      selectedApps: new Set(),
      searchQuery: '',
      error: null,
      activeSessions: {} // { appName: { status, message, msgPhase, intervalId } }
    };

    // === UTILS ===

    function escape(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function regionToEndpoint(code) {
      return 'https://api.cf.' + code + '.hana.ondemand.com';
    }

    function endpointToRegion(endpoint) {
      const m = endpoint.match(new RegExp('api[.]cf[.]([^.]+)[.]hana[.]ondemand[.]com'));
      return m ? m[1] : null;
    }

    function getRegionDisplay() {
      if (state.useCustomEndpoint) {
        const code = endpointToRegion(state.apiEndpoint);
        return code ? code + ' (custom)' : state.apiEndpoint;
      }
      const region = CF_REGIONS.find(r => r.code === state.selectedRegion);
      return region ? state.selectedRegion + ' \u2014 ' + region.name : state.selectedRegion;
    }

    function buildLiveStatus() {
      if (state.error) return 'Error: ' + state.error;
      if (state.screen === SCREENS.LOGGING_IN) return 'Logging in to Cloud Foundry...';
      if (state.screen === SCREENS.LOADING_APPS && state.selectedOrg) {
        return 'Loading apps for ' + state.selectedOrg + '...';
      }
      const activeCount = Object.keys(state.activeSessions).length;
      if (activeCount > 0) {
        return activeCount + ' debug session' + (activeCount === 1 ? '' : 's') + ' active.';
      }
      return '';
    }

    // === RENDERERS ===

    function render() {
      document.getElementById('app').innerHTML = renderScreen();
      attachListeners();
    }

    function renderScreen() {
      switch (state.screen) {
        case SCREENS.INITIAL:      return renderInitial();
        case SCREENS.REGION:       return renderRegion();
        case SCREENS.LOGGING_IN:   return renderLoggingIn();
        case SCREENS.SELECT_ORG:   return renderSelectOrg();
        case SCREENS.SELECT_FOLDER: return renderSelectFolder();
        case SCREENS.LOADING_APPS: return renderLoadingApps();
        case SCREENS.READY:        return renderReady();
        default:                   return '';
      }
    }

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
        icon = '<span style="color:var(--vscode-testing-iconPassed);margin-right:6px">●</span>';
        text = 'Debugger Attached';
      } else if (session.status === 'ERROR') {
        icon = '<span style="color:var(--vscode-testing-iconFailed);margin-right:6px">✖</span>';
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
            title="Stop Debug Session" aria-label="Stop debug for \${escape(appName)}">■</button>
        </div>
      \`;
    }

    function renderActiveSessionsContent() {
      const activeAppNames = Object.keys(state.activeSessions);
      if (activeAppNames.length === 0) return '';
      return \`
        <div class="section-label" style="display:flex;align-items:center;gap:6px">
          <span style="color:var(--vscode-testing-iconPassed)">●</span> Active Sessions
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

    // === LISTENERS ===

    function attachListeners() {
      const $ = id => document.getElementById(id);

      $('btn-select-folder')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'SELECT_ROOT_FOLDER' });
      });

      document.querySelectorAll('input[name="cf-region"]').forEach(el => {
        el.addEventListener('change', e => {
          const value = e.target.value;
          if (value === 'custom') {
            state.useCustomEndpoint = true;
          } else {
            state.useCustomEndpoint = false;
            state.selectedRegion = value;
            state.apiEndpoint = regionToEndpoint(value);
          }
          render();
        });
      });

      $('api-endpoint-custom')?.addEventListener('input', e => { state.apiEndpoint = e.target.value; });

      $('btn-login')?.addEventListener('click', () => {
        const endpoint = state.useCustomEndpoint ? state.apiEndpoint : regionToEndpoint(state.selectedRegion);
        state.apiEndpoint = endpoint;
        state.error = null;
        state.screen = SCREENS.LOGGING_IN;
        render();
        vscode.postMessage({ type: 'LOGIN', payload: { apiEndpoint: endpoint } });
      });

      $('btn-back-initial')?.addEventListener('click', () => {
        state.screen = SCREENS.INITIAL; state.error = null; render();
      });

      document.querySelectorAll('input[name="cf-org"]').forEach(el => {
        el.addEventListener('change', e => {
          state.selectedOrg = e.target.value;
          render();
        });
      });

      $('btn-next-org')?.addEventListener('click', () => {
        state.error = null;
        state.screen = SCREENS.SELECT_FOLDER;
        render();
      });

      document.querySelectorAll('input[name="cf-folder"]').forEach(el => {
        el.addEventListener('change', e => {
          state.selectedFolder = e.target.value;
          render();
        });
      });

      $('btn-save-mapping')?.addEventListener('click', () => {
        if (!state.selectedOrg || !state.selectedFolder) return;
        const mappings = [{ cfOrg: state.selectedOrg, localGroupPath: state.selectedFolder }];
        state.mappings = mappings;
        state.error = null;
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({ type: 'SAVE_MAPPINGS', payload: { mappings } });
        vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
      });

      $('btn-back-region')?.addEventListener('click', () => {
        state.screen = SCREENS.REGION; state.error = null; render();
      });

      $('btn-back-select-org')?.addEventListener('click', () => {
        state.screen = SCREENS.SELECT_ORG; state.error = null; render();
      });

      $('search-input')?.addEventListener('input', e => {
        state.searchQuery = e.target.value;
        refreshAppListSection();
      });

      // Event delegation on .app-list so listeners survive innerHTML replacement by refreshAppListSection()
      const appListEl = document.querySelector('.app-list');
      if (appListEl) {
        appListEl.addEventListener('change', e => {
          const cb = e.target.closest('input[type="checkbox"][data-app]');
          if (!cb) return;
          const name = cb.dataset.app;
          if (cb.checked) state.selectedApps.add(name);
          else state.selectedApps.delete(name);
          refreshAppListSection();
        });
      }

      const activePanel = document.getElementById('active-sessions-panel');
      if (activePanel) {
        activePanel.addEventListener('click', e => {
          const stopBtn = e.target.closest('[data-stop-app]');
          if (stopBtn) {
            vscode.postMessage({ type: 'STOP_DEBUG', payload: { appName: stopBtn.dataset.stopApp } });
            return;
          }
          const openBtn = e.target.closest('[data-open-url]');
          if (openBtn) {
            vscode.postMessage({ type: 'OPEN_APP_URL', payload: { url: openBtn.dataset.openUrl } });
          }
        });
      }

      $('btn-start-debug')?.addEventListener('click', () => {
        const appNames = [...state.selectedApps].filter(
          n => state.apps.find(a => a.name === n && a.state === 'started') && !state.activeSessions[n]
        );
        if (appNames.length === 0) return;
        // Remove from selection so UI checkbox unchecks while tunneling
        appNames.forEach(n => state.selectedApps.delete(n));
        vscode.postMessage({ type: 'START_DEBUG', payload: { appNames, org: state.selectedOrg } });
        render();
      });

      $('btn-remap')?.addEventListener('click', () => {
        state.screen = SCREENS.SELECT_ORG; state.error = null; render();
      });

      $('btn-reset-login')?.addEventListener('click', () => {
        state.error = null; state.screen = SCREENS.REGION; render();
        vscode.postMessage({ type: 'RESET_LOGIN' });
      });
    }

    // === MESSAGE HANDLER ===

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'ROOT_FOLDER_SELECTED':
          state.rootFolder = msg.payload.path;
          state.groupFolders = msg.payload.groupFolders;
          state.screen = SCREENS.REGION;
          state.error = null;
          break;
        case 'LOGIN_SUCCESS':
          state.orgs = msg.payload.orgs;
          state.screen = SCREENS.SELECT_ORG;
          state.error = null;
          break;
        case 'LOGIN_ERROR':
          state.error = msg.payload.message;
          state.screen = SCREENS.REGION;
          break;
        case 'APPS_LOADED':
          state.apps = msg.payload.apps;
          state.selectedApps = new Set();
          state.screen = SCREENS.READY;
          state.error = null;
          break;
        case 'APPS_ERROR':
          state.error = msg.payload.message;
          state.screen = SCREENS.READY;
          break;
        case 'DEBUG_CONNECTING': {
          msg.payload.appNames.forEach(appName => {
            state.activeSessions[appName] = { status: 'TUNNELING', msgPhase: 0 };
            const tId = setInterval(() => {
              if (state.activeSessions[appName]?.status === 'TUNNELING') {
                state.activeSessions[appName].msgPhase =
                  (state.activeSessions[appName].msgPhase + 1) % LOADING_MESSAGES.length;
                updateActiveCardStatusOnly(appName);
              }
            }, 1800);
            state.activeSessions[appName].intervalId = tId;
          });
          break;
        }
        case 'APP_DEBUG_STATUS': {
          const { appName, status, message } = msg.payload;
          if (status === 'EXITED') {
            const session = state.activeSessions[appName];
            if (session?.intervalId) clearInterval(session.intervalId);
            delete state.activeSessions[appName];
            render();
            return;
          }
          if (!state.activeSessions[appName]) {
            state.activeSessions[appName] = { status, message, msgPhase: 0 };
          } else {
            const session = state.activeSessions[appName];
            session.status = status;
            if (message) session.message = message;
            if (status === 'ATTACHED' || status === 'ERROR') {
              if (session.intervalId) clearInterval(session.intervalId);
            }
          }
          refreshActiveSessionsPanel();
          return;
        }
        case 'DEBUG_ERROR':
          state.error = msg.payload.message;
          state.screen = SCREENS.READY;
          break;
        case 'CONFIG_LOADED': {
          const cfg = msg.payload.config;
          if (cfg?.rootFolderPath) {
            state.rootFolder = cfg.rootFolderPath;
            state.apiEndpoint = cfg.apiEndpoint;
            const detectedRegion = endpointToRegion(cfg.apiEndpoint);
            if (detectedRegion && CF_REGIONS.some(r => r.code === detectedRegion)) {
              state.selectedRegion = detectedRegion;
              state.useCustomEndpoint = false;
            } else if (cfg.apiEndpoint) {
              state.useCustomEndpoint = true;
            }
            state.activeSessions = msg.payload.activeSessions ?? {};
            state.groupFolders = msg.payload.groupFolders ?? [];
            state.orgs = cfg.orgs ?? [];
            state.mappings = cfg.orgGroupMappings;
            if (state.mappings.length > 0) {
              state.selectedOrg = state.mappings[0].cfOrg;
              state.selectedFolder = state.mappings[0].localGroupPath;
              state.screen = SCREENS.LOADING_APPS;
              render();
              vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
              return;
            }
          }
          state.screen = SCREENS.INITIAL;
          break;
        }
      }
      render();
    });

    // === INIT ===

    vscode.postMessage({ type: 'LOAD_CONFIG' });
    render();
  </script>`;
}
