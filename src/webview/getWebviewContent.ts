function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function getWebviewContent(): string {
  const nonce = getNonce();
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

    .app-list { display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; }
    .app-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 6px;
      border-radius: 4px;
      cursor: pointer;
    }
    .app-row:hover { background: var(--vscode-list-hoverBackground); }
    .app-row.stopped { opacity: 0.5; }
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
    .mapping-arrow { text-align: center; color: var(--vscode-descriptionForeground); }

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
      LAUNCHING: 'launching',
    };

    let state = {
      screen: SCREENS.INITIAL,
      rootFolder: null,
      groupFolders: [],
      region: 'br10',
      orgs: [],
      mappings: [],
      selectedOrg: null,
      apps: [],
      selectedApps: new Set(),
      searchQuery: '',
      error: null,
    };

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
        case SCREENS.LAUNCHING: return renderLaunching();
        default:                return '';
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
      return \`
        <div class="step-header">
          <span class="step-badge">2/4</span>
          <span class="step-title">Select CF Region</span>
        </div>
        <div class="info-box">Root: <code>\${escape(state.rootFolder)}</code></div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="radio-group">
          <label class="radio-item">
            <input type="radio" name="region" value="br10" \${state.region === 'br10' ? 'checked' : ''} />
            <div>
              <div>BR10 &mdash; Brazil (São Paulo)</div>
              <div class="radio-desc">api.cf.br10.hana.ondemand.com</div>
            </div>
          </label>
          <label class="radio-item">
            <input type="radio" name="region" value="ap11" \${state.region === 'ap11' ? 'checked' : ''} />
            <div>
              <div>AP11 &mdash; Singapore</div>
              <div class="radio-desc">api.cf.ap11.hana.ondemand.com</div>
            </div>
          </label>
        </div>
        <div style="height:10px"></div>
        <button class="btn" id="btn-login">Login to Cloud Foundry</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-initial">Back</button>
      \`;
    }

    function renderLoggingIn() {
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          Logging in to CF \${escape(state.region.toUpperCase())}&hellip;
        </div>
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

    function renderReady() {
      const filtered = state.apps.filter(app =>
        !state.searchQuery || app.name.toLowerCase().includes(state.searchQuery.toLowerCase())
      );
      const started = filtered.filter(a => a.state === 'started');
      const stopped = filtered.filter(a => a.state === 'stopped');
      const selectedCount = [...state.selectedApps].filter(n =>
        state.apps.find(a => a.name === n && a.state === 'started')
      ).length;

      const orgOptions = state.mappings.map(m => \`
        <option value="\${escape(m.cfOrg)}" \${m.cfOrg === state.selectedOrg ? 'selected' : ''}>
          \${escape(m.cfOrg)}
        </option>
      \`).join('');

      const renderApps = (apps, section) => apps.length === 0 ? '' : \`
        <div class="section-label">\${section}</div>
        \${apps.map(app => \`
          <label class="app-row \${app.state === 'stopped' ? 'stopped' : ''}">
            <input type="checkbox" data-app="\${escape(app.name)}"
              \${state.selectedApps.has(app.name) ? 'checked' : ''}
              \${app.state === 'stopped' ? 'disabled' : ''} />
            <span class="app-name" title="\${escape(app.name)}">\${escape(app.name)}</span>
            <span class="badge badge-\${app.state}">\${app.state}</span>
          </label>
        \`).join('')}
      \`;

      return \`
        <div class="step-header">
          <span class="step-badge">4/4</span>
          <span class="step-title">Debug Launcher</span>
        </div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">Cloud Foundry Org</div>
        <select class="select" id="org-select">\${orgOptions}</select>
        <div style="height:8px"></div>
        <input class="input" id="search-input" placeholder="Search apps&hellip;" value="\${escape(state.searchQuery)}" />
        <div style="height:8px"></div>
        <label class="app-row" style="margin-bottom:4px">
          <input type="checkbox" id="check-all-started"
            \${selectedCount > 0 && selectedCount === started.length ? 'checked' : ''} />
          <span style="font-size:12px">Select all started</span>
        </label>
        <div class="divider"></div>
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

    function renderLaunching() {
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          Starting debug sessions&hellip;
        </div>
      \`;
    }

    function attachListeners() {
      const $ = id => document.getElementById(id);

      $('btn-select-folder')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'SELECT_ROOT_FOLDER' });
      });

      document.querySelectorAll('input[name=region]').forEach(el => {
        el.addEventListener('change', e => { state.region = e.target.value; });
      });

      $('btn-login')?.addEventListener('click', () => {
        state.error = null;
        state.screen = SCREENS.LOGGING_IN;
        render();
        vscode.postMessage({ type: 'LOGIN', payload: { region: state.region } });
      });

      $('btn-back-initial')?.addEventListener('click', () => {
        state.screen = SCREENS.INITIAL;
        state.error = null;
        render();
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
          state.error = 'Map at least one org to a local folder.';
          render();
          return;
        }
        state.error = null;
        state.selectedOrg = mappings[0].cfOrg;
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({ type: 'SAVE_MAPPINGS', payload: { mappings } });
        vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
      });

      $('btn-back-region')?.addEventListener('click', () => {
        state.screen = SCREENS.REGION;
        state.error = null;
        render();
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
        state.searchQuery = e.target.value;
        render();
      });

      $('check-all-started')?.addEventListener('change', e => {
        const started = state.apps.filter(a => a.state === 'started');
        if (e.target.checked) {
          started.forEach(a => state.selectedApps.add(a.name));
        } else {
          started.forEach(a => state.selectedApps.delete(a.name));
        }
        render();
      });

      document.querySelectorAll('[data-app]').forEach(el => {
        el.addEventListener('change', e => {
          const name = e.target.dataset.app;
          if (e.target.checked) state.selectedApps.add(name);
          else state.selectedApps.delete(name);
          render();
        });
      });

      $('btn-start-debug')?.addEventListener('click', () => {
        const appNames = [...state.selectedApps].filter(
          n => state.apps.find(a => a.name === n && a.state === 'started')
        );
        if (appNames.length === 0) return;
        state.screen = SCREENS.LAUNCHING;
        render();
        vscode.postMessage({ type: 'START_DEBUG', payload: { appNames, org: state.selectedOrg } });
      });

      $('btn-remap')?.addEventListener('click', () => {
        state.screen = SCREENS.MAPPING;
        state.error = null;
        render();
      });
    }

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
          state.screen = SCREENS.MAPPING;
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
        case 'DEBUG_STARTED':
          state.screen = SCREENS.READY;
          state.error = null;
          break;
        case 'DEBUG_ERROR':
          state.error = msg.payload.message;
          state.screen = SCREENS.READY;
          break;
        case 'CONFIG_LOADED':
          if (msg.payload.config) {
            const cfg = msg.payload.config;
            state.rootFolder = cfg.rootFolderPath;
            state.region = cfg.region;
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
