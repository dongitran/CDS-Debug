export function getWebviewContent(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const nonce = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SAP CAP Debug Launcher</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      min-height: 100vh;
    }

    h2 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
    }

    .section-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin: 14px 0 6px;
    }

    .btn {
      display: block;
      width: 100%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 7px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      text-align: center;
      transition: background 0.2s;
    }
    .btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }

    .input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      outline: none;
      transition: border-color 0.2s;
    }
    .input:focus { border-color: var(--vscode-focusBorder); }

    .select {
      width: 100%;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
    }

    .radio-group { display: flex; flex-direction: column; gap: 6px; }
    .radio-item {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
    }
    .radio-item:hover { background: var(--vscode-list-hoverBackground); }
    .radio-item input[type=radio] { cursor: pointer; }
    .radio-desc { font-size: 11px; color: var(--vscode-descriptionForeground); }

    .region-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-bottom: 8px;
    }
    .region-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 8px 6px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
      cursor: pointer;
      text-align: center;
      transition: border-color 0.1s, background 0.1s;
    }
    .region-card:hover { background: var(--vscode-list-hoverBackground); }
    .region-card.selected {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .region-card input[type=radio] { display: none; }
    .region-code { font-size: 13px; font-weight: 700; font-family: var(--vscode-editor-font-family); }
    .region-name { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .region-card.selected .region-name { color: inherit; opacity: 0.8; }
    .region-card-custom {
      grid-column: 1 / -1;
    }

    .app-list { display: flex; flex-direction: column; gap: 2px; max-height: 400px; overflow-y: auto; padding-right: 2px; }
    .app-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 6px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .app-row:hover:not(.stopped) { background: var(--vscode-list-hoverBackground); }
    .app-row.stopped { opacity: 0.5; cursor: not-allowed; }
    .app-name {
      flex: 1;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 99px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .badge-started { background: #2d7d46; color: #fff; }
    .badge-stopped { background: #6e6e6e; color: #fff; }

    .divider { height: 1px; background: var(--vscode-panel-border); margin: 12px 0; }

    .info-box {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      padding: 8px 10px;
      border-radius: 0 4px 4px 0;
      font-size: 12px;
      margin-bottom: 10px;
    }

    .error-box {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 12px;
      margin-bottom: 10px;
    }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .step-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
    }
    .step-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 99px;
    }
    .step-title { font-size: 13px; font-weight: 600; }

    .mapping-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 6px;
      align-items: center;
    }
    
    /* New Status Cards for Unified Flow */
    .active-card {
      display: flex;
      align-items: center;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      animation: slideIn 0.3s ease;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .active-card-main { flex: 1; min-width: 0; }
    .active-card-title {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 4px;
    }
    .active-card-status {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .active-stop-btn {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      margin-left: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--vscode-testing-iconFailed);
      color: var(--vscode-testing-iconFailed);
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      transition: all 0.2s;
    }
    .active-stop-btn:hover {
      background: var(--vscode-testing-iconFailed);
      color: white;
    }
    .status-text-anim {
      display: inline-block;
      animation: fadeIn 0.4s;
    }
    @keyframes fadeIn { from { opacity: 0.3; } to { opacity: 1; } }

    .footer {
      position: sticky;
      bottom: 0;
      padding: 10px 0 0;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 10px;
    }
    .footer-info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="app"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const SCREENS = {
      INITIAL: 'initial',
      REGION: 'region',
      LOGGING_IN: 'logging-in',
      MAPPING: 'mapping',
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

    function regionToEndpoint(code) { return 'https://api.cf.' + code + '.hana.ondemand.com'; }
    function endpointToRegion(endpoint) {
      const m = endpoint.match(new RegExp('api[.]cf[.]([^.]+)[.]hana[.]ondemand[.]com'));
      return m ? m[1] : null;
    }

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
      apps: [],
      selectedApps: new Set(),
      searchQuery: '',
      error: null,
      activeSessions: {} // { appName: { status, message, msgPhase, intervalId } }
    };

    const LOADING_MESSAGES = [
      "Opening SSH tunnel...",
      "Mapping local ports...",
      "Waiting for trace route...",
      "Establishing connection..."
    ];

    function escape(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function render() {
      const root = document.getElementById('app');
      root.innerHTML = renderScreen();
      attachListeners();
    }

    function renderScreen() {
      switch (state.screen) {
        case SCREENS.INITIAL:   return renderInitial();
        case SCREENS.REGION:    return renderRegion();
        case SCREENS.LOGGING_IN: return renderLoggingIn();
        case SCREENS.MAPPING:   return renderMapping();
        case SCREENS.LOADING_APPS: return renderLoadingApps();
        case SCREENS.READY:     return renderReady();
        default:                return '';
      }
    }

    // [Skipping unchanged renderInitial, renderRegion, renderLoggingIn, renderMapping, renderLoadingApps for brevity but they are intact]
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

    function renderMapping() {
      const rows = state.orgs.map((org, i) => \`
        <div class="mapping-row">
          <div style="font-size:12px;font-family:var(--vscode-editor-font-family);overflow:hidden;text-overflow:ellipsis"
               title="\${escape(org)}">\${escape(org)}</div>
          <select class="select" data-org="\${escape(org)}" id="map-\${i}">
            <option value="">-- skip --</option>
            \${state.groupFolders.map(f => \`<option value="\${escape(f)}" \${
              state.mappings.find(m => m.cfOrg === org)?.localGroupPath === f ? 'selected' : ''
            }>\${escape(f)}</option>\`).join('')}
          </select>
        </div>
      \`).join('');

      return \`
        <div class="step-header">
          <span class="step-badge">3/4</span>
          <span class="step-title">Map Orgs to Folders</span>
        </div>
        <div class="info-box">Match each CF org to its local group folder.</div>
        <div class="section-label">CF Org &rarr; Local Folder</div>
        \${rows}
        <div style="height:10px"></div>
        <button class="btn" id="btn-save-mappings">Save &amp; Continue</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-region">Back</button>
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

    // Unified READY Screen with Active Sessions Panel
    function renderReady() {
      const filtered = state.apps.filter(app =>
        !state.searchQuery || app.name.toLowerCase().includes(state.searchQuery.toLowerCase())
      );
      const started = filtered.filter(a => a.state === 'started');
      const stopped = filtered.filter(a => a.state === 'stopped');

      const activeAppNames = Object.keys(state.activeSessions);
      const hasActive = activeAppNames.length > 0;

      // Selection counts ignore actively debugged apps
      const selectedCount = [...state.selectedApps].filter(n =>
        state.apps.find(a => a.name === n && a.state === 'started') && !state.activeSessions[n]
      ).length;

      const orgOptions = state.mappings.map(m => \`
        <option value="\${escape(m.cfOrg)}" \${m.cfOrg === state.selectedOrg ? 'selected' : ''}>
          \${escape(m.cfOrg)}
        </option>
      \`).join('');

      // Top Panel: Active Debug Sessions
      const renderActiveCard = (appName) => {
        const session = state.activeSessions[appName];
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

        return \`
          <div class="active-card">
            <div class="active-card-main">
              <div class="active-card-title" title="\${escape(appName)}">\${escape(appName)}</div>
              <div class="active-card-status">
                \${icon}
                <span class="status-text-anim" key="\${session.msgPhase}">\${escape(text)}</span>
              </div>
            </div>
            <button class="active-stop-btn" data-stop-app="\${escape(appName)}" title="Stop Debug Session">■</button>
          </div>
        \`;
      };

      const activeSection = hasActive ? \`
        <div class="section-label" style="display:flex;align-items:center;gap:6px">
          <span style="color:var(--vscode-testing-iconPassed)">●</span> Active Sessions
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
          \${activeAppNames.map(renderActiveCard).join('')}
        </div>
        <div class="divider"></div>
      \` : '';

      // Bottom Panel: App List
      const renderApps = (apps, section) => apps.length === 0 ? '' : \`
        <div class="section-label">\${section}</div>
        \${apps.map(app => {
          const isActive = !!state.activeSessions[app.name];
          const isDisabled = app.state === 'stopped' || isActive;
          const isChecked = state.selectedApps.has(app.name) && !isActive;
          return \`
          <label class="app-row \${isDisabled ? 'stopped' : ''}">
            <input type="checkbox" data-app="\${escape(app.name)}"
              \${isChecked ? 'checked' : ''}
              \${isDisabled ? 'disabled' : ''} />
            <span class="app-name" title="\${escape(app.name)}">\${escape(app.name)}</span>
            <span class="badge badge-\${app.state}">\${app.state}</span>
          </label>
        \`}).join('')}
      \`;

      // Available started not actively debugging
      const availableStarted = started.filter(a => !state.activeSessions[a.name]);

      return \`
        <div class="step-header">
          <span class="step-badge">4/4</span>
          <span class="step-title">Debug Launcher</span>
        </div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        
        \${activeSection}

        <div class="section-label">Cloud Foundry Org</div>
        <select class="select" id="org-select">\${orgOptions}</select>
        <div style="height:8px"></div>
        <input class="input" id="search-input" placeholder="Search apps&hellip;" value="\${escape(state.searchQuery)}" />
        <div style="height:8px"></div>
        
        <label class="app-row" style="margin-bottom:4px">
          <input type="checkbox" id="check-all-started"
            \${selectedCount > 0 && selectedCount === availableStarted.length ? 'checked' : ''} 
            \${availableStarted.length === 0 ? 'disabled' : ''} />
          <span style="font-size:12px">Select all start-ready</span>
        </label>
        
        <div class="app-list">
          \${renderApps(started, 'Started')}
          \${renderApps(stopped, 'Stopped')}
          \${filtered.length === 0 ? '<div style="text-align:center;padding:16px;color:var(--vscode-descriptionForeground)">No apps found</div>' : ''}
        </div>
        
        <div class="footer">
          <div class="footer-info">\${selectedCount} service\${selectedCount !== 1 ? 's' : ''} selected</div>
          <button class="btn" id="btn-start-debug" \${selectedCount === 0 ? 'disabled' : ''}>
            &#9654; Start Debug Sessions
          </button>
          <div style="height:6px"></div>
          <button class="btn btn-secondary" id="btn-remap">&#8592; Change Mapping</button>
        </div>
      \`;
    }

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

      $('btn-save-mappings')?.addEventListener('click', () => {
        const mappings = [];
        document.querySelectorAll('[data-org]').forEach(el => {
          const org = el.dataset.org;
          const val = el.value;
          if (val) mappings.push({ cfOrg: org, localGroupPath: val });
        });
        state.mappings = mappings;
        if (mappings.length === 0) {
          state.error = 'Map at least one org to a local folder.'; render(); return;
        }
        state.error = null;
        state.selectedOrg = mappings[0].cfOrg;
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({ type: 'SAVE_MAPPINGS', payload: { mappings } });
        vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
      });

      $('btn-back-region')?.addEventListener('click', () => {
        state.screen = SCREENS.REGION; state.error = null; render();
      });

      $('org-select')?.addEventListener('change', e => {
        state.selectedOrg = e.target.value;
        state.selectedApps = new Set();
        state.searchQuery = '';
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
      });

      $('search-input')?.addEventListener('input', e => {
        state.searchQuery = e.target.value; render();
      });

      $('check-all-started')?.addEventListener('change', e => {
        const availableStarted = state.apps.filter(a => a.state === 'started' && !state.activeSessions[a.name]);
        if (e.target.checked) {
          availableStarted.forEach(a => state.selectedApps.add(a.name));
        } else {
          availableStarted.forEach(a => state.selectedApps.delete(a.name));
        }
        render();
      });

      document.querySelectorAll('input[type="checkbox"][data-app]').forEach(el => {
        el.addEventListener('change', e => {
          const name = e.target.dataset.app;
          if (e.target.checked) state.selectedApps.add(name);
          else state.selectedApps.delete(name);
          render();
        });
      });

      // STOP BUTTON LISTENER
      document.querySelectorAll('[data-stop-app]').forEach(el => {
        el.addEventListener('click', e => {
          const btn = e.target.closest('[data-stop-app]');
          if (btn) {
            const appName = btn.dataset.stopApp;
            vscode.postMessage({ type: 'STOP_DEBUG', payload: { appName } });
          }
        });
      });

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
        state.screen = SCREENS.MAPPING; state.error = null; render();
      });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'ROOT_FOLDER_SELECTED':
          state.rootFolder = msg.payload.path; state.groupFolders = msg.payload.groupFolders;
          state.screen = SCREENS.REGION; state.error = null;
          break;
        case 'LOGIN_SUCCESS':
          state.orgs = msg.payload.orgs; state.screen = SCREENS.MAPPING; state.error = null;
          break;
        case 'LOGIN_ERROR':
          state.error = msg.payload.message; state.screen = SCREENS.REGION;
          break;
        case 'APPS_LOADED':
          state.apps = msg.payload.apps; state.selectedApps = new Set();
          state.screen = SCREENS.READY; state.error = null;
          break;
        case 'APPS_ERROR':
          state.error = msg.payload.message; state.screen = SCREENS.READY;
          break;
        
        // --- NEW REALTIME DEBUG FLOW --- //
        case 'DEBUG_CONNECTING': {
          const apps = msg.payload.appNames;
          apps.forEach(appName => {
            state.activeSessions[appName] = { status: 'TUNNELING', msgPhase: 0 };
            const tId = setInterval(() => {
              if (state.activeSessions[appName] && state.activeSessions[appName].status === 'TUNNELING') {
                state.activeSessions[appName].msgPhase = (state.activeSessions[appName].msgPhase + 1) % LOADING_MESSAGES.length;
                render();
              }
            }, 1800);
            state.activeSessions[appName].intervalId = tId;
          });
          render();
          break;
        }
        case 'APP_DEBUG_STATUS': {
          const { appName, status, message } = msg.payload;
          if (status === 'EXITED') {
            const session = state.activeSessions[appName];
            if (session && session.intervalId) clearInterval(session.intervalId);
            delete state.activeSessions[appName];
          } else {
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
          }
          render();
          break;
        }
        case 'DEBUG_ERROR':
          state.error = msg.payload.message; state.screen = SCREENS.READY;
          break;
        case 'CONFIG_LOADED':
          if (msg.payload.config && msg.payload.config.rootFolderPath) {
            const cfg = msg.payload.config;
            state.rootFolder = cfg.rootFolderPath;
            state.apiEndpoint = cfg.apiEndpoint;
            const detectedRegion = endpointToRegion(cfg.apiEndpoint);
            if (detectedRegion && CF_REGIONS.some(r => r.code === detectedRegion)) {
              state.selectedRegion = detectedRegion; state.useCustomEndpoint = false;
            } else if (cfg.apiEndpoint) {
              state.useCustomEndpoint = true;
            }
            state.mappings = cfg.orgGroupMappings;
            if (state.mappings.length > 0) {
              state.selectedOrg = state.mappings[0].cfOrg;
              state.screen = SCREENS.LOADING_APPS;
              render();
              vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
              return;
            }
          }
          state.screen = SCREENS.INITIAL;
          break;
      }
      render();
    });

    vscode.postMessage({ type: 'LOAD_CONFIG' });
    render();
  </script>
</body>
</html>`;
}
