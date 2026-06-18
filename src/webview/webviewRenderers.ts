/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getRendererScriptContent(): string {
  return `
    function hasReadyTopology() {
      return !!state.cfTopology
        && state.cfTopology.ready
        && Array.isArray(state.cfTopology.accounts)
        && state.cfTopology.accounts.length > 0;
    }

    function filterTopologyAccounts(accounts, query) {
      const q = String(query || '').trim().toLowerCase();
      if (q.length === 0) return accounts.slice(0, 50);
      const matches = [];
      for (const account of accounts) {
        const haystack = (
          account.orgName + ' ' + account.regionKey + ' ' + account.regionLabel
        ).toLowerCase();
        if (haystack.indexOf(q) !== -1) matches.push(account);
        if (matches.length >= 50) break;
      }
      return matches;
    }

    function filterRegions(query) {
      const q = String(query || '').trim().toLowerCase();
      if (q.length === 0) return CF_REGIONS;
      return CF_REGIONS.filter(region => {
        const haystack = (
          region.code + ' ' + region.name + ' ' + region.label + ' ' + region.apiEndpoint
        ).toLowerCase();
        return haystack.indexOf(q) !== -1;
      });
    }

    function findTopologyAccount(regionKey, orgName) {
      const accounts = (state.cfTopology && state.cfTopology.accounts) || [];
      for (const account of accounts) {
        if (account.regionKey === regionKey && account.orgName === orgName) return account;
      }
      return null;
    }

    function isSelectedTopologyOrg(account) {
      return !!state.selectedTopologyOrg
        && state.selectedTopologyOrg.regionKey === account.regionKey
        && state.selectedTopologyOrg.orgName === account.orgName;
    }

    function renderSearchField(inputId, value, placeholder, label) {
      return \`
        <label class="sr-only" for="\${escape(inputId)}">\${escape(label)}</label>
        <div class="search-input-wrap">
          <span class="search-input-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" focusable="false">
              <path d="M6.75 2.25a4.5 4.5 0 0 1 3.56 7.25l3.1 3.1a.57.57 0 0 1-.81.81l-3.1-3.1a4.5 4.5 0 1 1-2.75-8.06Zm0 1.15a3.35 3.35 0 1 0 0 6.7 3.35 3.35 0 0 0 0-6.7Z"></path>
            </svg>
          </span>
          <input class="input search-input" id="\${escape(inputId)}" type="search"
            placeholder="\${escape(placeholder)}"
            value="\${escape(value || '')}"
            autocomplete="off" spellcheck="false" />
        </div>
      \`;
    }

    function renderOrgSearchRows(filtered) {
      const rows = filtered.map(account => {
        const spaceCount = Array.isArray(account.spaces) ? account.spaces.length : 0;
        const meta = account.regionKey + ' · ' + spaceCount + ' space' + (spaceCount === 1 ? '' : 's');
        const selected = isSelectedTopologyOrg(account);
        return \`
          <button class="org-search-row \${selected ? 'selected' : ''}" type="button"
               data-org-search-region="\${escape(account.regionKey)}"
               data-org-search-org="\${escape(account.orgName)}"
               aria-pressed="\${selected ? 'true' : 'false'}"
               title="\${escape(account.orgName)} — \${escape(account.regionLabel)}">
            <span class="org-search-org">\${escape(account.orgName)}</span>
            <span class="org-search-meta">\${escape(meta)}</span>
          </button>
        \`;
      }).join('');
      return filtered.length === 0
        ? \`<div class="org-search-results empty">No org matches "\${escape(state.orgSearchQuery || '')}"</div>\`
        : \`<div class="org-search-results">\${rows}</div>\`;
    }

    function renderOrgSearchPanel() {
      const topology = state.cfTopology || { ready: false, accounts: [] };
      const filtered = filterTopologyAccounts(topology.accounts || [], state.orgSearchQuery);
      const totalLabel = topology.accounts.length === 1
        ? '1 org synced across all regions'
        : topology.accounts.length + ' orgs synced across all regions';
      return \`
        <div class="section-label">Search org (across regions)</div>
        <div class="org-search-block">
          \${renderSearchField('org-search-input', state.orgSearchQuery, 'Type to search orgs in any region...', 'Search orgs across regions')}
          \${renderOrgSearchRows(filtered)}
          <div class="radio-desc">\${escape(totalLabel)}</div>
        </div>
      \`;
    }

    function renderRegionCards() {
      const filteredRegions = filterRegions(state.regionSearchQuery);
      const regionCards = filteredRegions.map(r => \`
        <label class="region-card \${!state.useCustomEndpoint && state.selectedRegion === r.code ? 'selected' : ''}">
          <input type="radio" name="cf-region" value="\${escape(r.code)}"
            \${!state.useCustomEndpoint && state.selectedRegion === r.code ? 'checked' : ''} />
          <span class="region-card-content">
            <span class="region-main">
              <span class="region-code">\${escape(r.code)}</span>
              <span class="region-name">\${escape(r.name)}</span>
            </span>
            <span class="region-endpoint">\${escape(r.apiEndpoint)}</span>
          </span>
        </label>
      \`).join('');

      if (!regionCards) {
        return \`<div class="region-list-empty">No regions match "\${escape(state.regionSearchQuery || '')}"</div>\`;
      }
      return regionCards;
    }

    function renderRegionPickerPanel(includeSearch) {
      if (state.useCustomEndpoint) return renderCustomEndpointPanel();

      const searchHtml = includeSearch ? \`
        <div class="region-search-block">
          \${renderSearchField('region-search-input', state.regionSearchQuery, 'Type to filter regions...', 'Search regions')}
        </div>
      \` : '';

      return \`
        <div class="section-label">Select Region</div>
        \${searchHtml}
        <div class="region-list" role="radiogroup" aria-label="Cloud Foundry regions">
          \${renderRegionCards()}
        </div>
        <div class="radio-desc region-current-endpoint">
          Endpoint: <code>\${escape(regionToEndpoint(state.selectedRegion))}</code>
        </div>
      \`;
    }

    function renderCustomEndpointPanel() {
      return \`
        <div class="custom-endpoint-panel">
          <div class="section-label">Custom Endpoint</div>
          <label class="sr-only" for="api-endpoint-custom">Custom CF API endpoint</label>
          <input class="input custom-endpoint-input" id="api-endpoint-custom" type="url"
            placeholder="https://api.cf.<region>.<domain>"
            value="\${escape(state.apiEndpoint)}"
            autocomplete="off" spellcheck="false" />
          <div class="radio-desc custom-endpoint-hint">Enter your full CF API URL</div>
          <button class="btn btn-secondary custom-endpoint-back" id="btn-region-list" type="button">
            Back to region list
          </button>
        </div>
      \`;
    }

    function renderRegionTabs() {
      const mode = state.regionSelectorMode === 'region' ? 'region' : 'org';
      const regionLabel = state.useCustomEndpoint ? 'Region (Custom)' : 'Region';
      return \`
        <div class="region-selector-tabs" role="tablist" aria-label="Cloud Foundry selector">
          <button class="selector-tab \${mode === 'org' ? 'active' : ''}" type="button"
            role="tab" aria-selected="\${mode === 'org' ? 'true' : 'false'}"
            data-region-selector-mode="org">Org</button>
          <button class="selector-tab \${mode === 'region' ? 'active' : ''}" type="button"
            role="tab" aria-selected="\${mode === 'region' ? 'true' : 'false'}"
            data-region-selector-mode="region">\${regionLabel}</button>
        </div>
      \`;
    }

    function renderRegionFooter(topologyReady) {
      const showCustomButton = (!topologyReady || state.regionSelectorMode === 'region') && !state.useCustomEndpoint;
      const customButton = showCustomButton
        ? '<button class="btn btn-secondary" id="btn-custom-endpoint" type="button">Custom endpoint</button>'
        : '';
      let loginButton;
      if (!topologyReady || state.regionSelectorMode === 'region') {
        loginButton = '<button class="btn" id="btn-login">Login to Cloud Foundry</button>';
      } else {
        const disabled = findSelectedTopologyAccount() ? '' : 'disabled';
        const label = disabled ? 'Select an Org to Continue' : 'Continue with Selected Org';
        loginButton = \`<button class="btn" id="btn-login" \${disabled}>\${label}</button>\`;
      }
      return \`<div class="region-actions">\${customButton}\${loginButton}</div>\`;
    }

    function findSelectedTopologyAccount() {
      if (!state.selectedTopologyOrg) return null;
      return findTopologyAccount(state.selectedTopologyOrg.regionKey, state.selectedTopologyOrg.orgName);
    }

    function renderRegion() {
      const topologyReady = hasReadyTopology();
      const activePanel = state.regionSelectorMode === 'region'
        ? renderRegionPickerPanel(true)
        : renderOrgSearchPanel();

      return \`
        <div class="region-layout \${topologyReady ? 'topology-ready' : ''}">
          <div class="step-header">
            <span class="step-badge">1/3</span>
            <span class="step-title">CF Region / Org</span>
          </div>
          \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
          \${topologyReady ? renderRegionTabs() : ''}
          <div class="region-tab-panel" role="tabpanel">
            \${topologyReady ? activePanel : renderRegionPickerPanel(true)}
          </div>
          \${renderRegionFooter(topologyReady)}
        </div>
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

    function renderLoadingSpaces() {
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          Loading spaces for <strong>\${escape(state.selectedOrg)}</strong>&hellip;
        </div>
        <div style="height:16px"></div>
        <button class="btn btn-secondary" id="btn-back-space-org">&#8592; Back</button>
      \`;
    }

    function renderSelectSpace() {
      const spaces = state.selectedOrg ? (state.spacesByOrg[state.selectedOrg] || []) : [];
      const items = spaces.map(space => \`
        <label class="space-item \${space === state.selectedSpace ? 'selected' : ''}">
          <input type="radio" name="cf-space" value="\${escape(space)}"
            \${space === state.selectedSpace ? 'checked' : ''} />
          <span class="space-item-name" title="\${escape(space)}">\${escape(space)}</span>
        </label>
      \`).join('');

      return \`
        <div class="step-header">
          <span class="step-badge">2/3</span>
          <span class="step-title">Select CF Space</span>
        </div>
        <div class="info-box">Org: <code>\${escape(state.selectedOrg ?? '')}</code></div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">CF Space</div>
        <div class="space-list">
          \${items || \`<div class="org-list-empty">No spaces found.</div>\`}
        </div>
        <div style="height:10px"></div>
        <button class="btn" id="btn-next-space" \${!state.selectedSpace ? 'disabled' : ''}>Next &rarr;</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-space-org">Back</button>
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
        <div class="info-box">
          Org: <code>\${escape(state.selectedOrg ?? '')}</code><br>
          Space: <code>\${escape(state.selectedSpace ?? '')}</code>
        </div>
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
      const targetText = state.selectedSpace
        ? state.selectedOrg + ' / ' + state.selectedSpace
        : state.selectedOrg;
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          Loading apps for <strong>\${escape(targetText)}</strong>&hellip;
        </div>
        <div style="height:16px"></div>
        <button class="btn btn-secondary" id="btn-cancel-load-apps">&#8592; Cancel</button>
      \`;
    }

    function getStatusInnerHtml(session) {
      if (session.status === 'PENDING') {
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">Preparing\u2026</span>';
      }
      if (session.status === 'DISCOVERING') {
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">Discovering remote folder\u2026</span>';
      }
      if (session.status === 'SSH_ENABLING') {
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">Enabling SSH\u2026</span>';
      }
      if (session.status === 'SSH_RESTARTING') {
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">Restarting app\u2026</span>';
      }
      if (session.status === 'TUNNELING') {
        const text = LOADING_MESSAGES[session.msgPhase] || 'Connecting...';
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">' + escape(text) + '</span>';
      }
      if (session.status === 'ATTACHED') {
        const noSrc = session.noLocalFolder
          ? '<span class="active-card-no-src" title="No local source folder found \u2014 debug console only">no src</span>'
          : '';
        return '<span style="color:var(--vscode-testing-iconPassed);margin-right:6px">&#9679;</span>'
          + '<span class="status-text-anim">Debugger Attached</span>'
          + noSrc;
      }
      if (session.status === 'ERROR') {
        return '<span style="color:var(--vscode-testing-iconFailed);margin-right:6px">&#10006;</span>'
          + '<span class="status-text-anim">' + escape(session.message || 'Connection Error') + '</span>';
      }
      return '';
    }

    function buildPackagesButtonHtml(appName) {
      return '<button class="active-packages-btn" data-packages-app="' + escape(appName) + '"'
        + ' title="Open loaded packages" aria-label="Open packages for ' + escape(appName) + '">'
        + 'Package</button>';
    }

    function renderActiveCard(appName) {
      const session = state.activeSessions[appName];
      const portText = session.port ? '<span class="active-card-port">:' + session.port + '</span>' : '';
      const packagesBtn = session.status === 'ATTACHED'
        ? buildPackagesButtonHtml(appName)
        : '';

      const retryBtn = session.status === 'ERROR' ? \`
        <button class="active-retry-btn" data-retry-app="\${escape(appName)}"
          title="Retry connection" aria-label="Retry debug for \${escape(appName)}">&#8635;</button>
      \` : '';

      return \`
        <div class="active-card" data-app-name="\${escape(appName)}" data-status="\${escape((session.status || '').toLowerCase())}">
          <div class="active-card-main">
            <div class="active-card-title" title="\${escape(appName)}">\${escape(appName)}\${portText}</div>
            <div class="active-card-status">\${getStatusInnerHtml(session)}</div>
          </div>
          \${packagesBtn}
          \${retryBtn}
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
        <div class="section-label" style="display:flex;align-items:center;gap:6px;margin:8px 0 6px">
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
        // Keep data-status in sync for CSS status-accent styling
        card.dataset.status = (session.status || '').toLowerCase();

        const existingPackagesBtn = card.querySelector('[data-packages-app]');
        const stopBtn = card.querySelector('[data-stop-app]');

        if (session.status === 'ATTACHED' && !existingPackagesBtn && stopBtn) {
          const tmp = document.createElement('div');
          tmp.innerHTML = buildPackagesButtonHtml(appName);
          stopBtn.parentNode.insertBefore(tmp.firstChild, stopBtn);
        } else if (session.status !== 'ATTACHED' && existingPackagesBtn) {
          existingPackagesBtn.remove();
        }

        // Retry button: show on ERROR, hide otherwise
        const existingRetryBtn = card.querySelector('[data-retry-app]');
        if (session.status === 'ERROR' && !existingRetryBtn && stopBtn) {
          const tmp = document.createElement('div');
          tmp.innerHTML = '<button class="active-retry-btn" data-retry-app="' + escape(appName) + '"'
            + ' title="Retry connection" aria-label="Retry debug for ' + escape(appName) + '">&#8635;</button>';
          stopBtn.parentNode.insertBefore(tmp.firstChild, stopBtn);
        } else if (session.status !== 'ERROR' && existingRetryBtn) {
          existingRetryBtn.remove();
        }
      }
    }

    function formatSnapshotTimestamp(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour12: false });
    }

    function formatSnapshotLocation(snapshot) {
      if (!snapshot.location) return 'unknown source';
      const src = snapshot.location.sourcePath || 'unknown source';
      const shortSrc = src.split('/').slice(-1)[0] || src;
      return shortSrc + ':' + snapshot.location.line;
    }

    function appendSnapshotVariables(lines, variables, depth, maxDepth) {
      const indent = '  '.repeat(depth);
      for (let i = 0; i < variables.length; i++) {
        const v = variables[i];
        const typeText = v.type ? ' <' + v.type + '>' : '';
        lines.push(indent + v.name + typeText + ' = ' + v.value);
        if (v.children && v.children.length > 0 && depth < maxDepth) {
          appendSnapshotVariables(lines, v.children, depth + 1, maxDepth);
        } else if (v.children && v.children.length > 0) {
          lines.push(indent + '  ...');
        }
      }
    }

    function buildSnapshotDetailText(snapshot) {
      const lines = [];
      lines.push('App: ' + snapshot.appName);
      lines.push('Session: ' + snapshot.sessionName);
      lines.push('Time: ' + new Date(snapshot.createdAt).toLocaleString());
      lines.push('Mode: ' + (snapshot.autoResumed ? 'Auto-continued' : 'Paused'));
      if (snapshot.location) {
        lines.push('Location: ' + snapshot.location.sourcePath + ':' + snapshot.location.line + ':' + snapshot.location.column);
        if (snapshot.location.functionName) lines.push('Function: ' + snapshot.location.functionName);
      }
      lines.push('');

      if (snapshot.captureError) {
        lines.push('Capture error: ' + snapshot.captureError);
        return lines.join('\\n');
      }

      if (!snapshot.scopes || snapshot.scopes.length === 0) {
        lines.push('No scopes/variables captured.');
        return lines.join('\\n');
      }

      for (let i = 0; i < snapshot.scopes.length; i++) {
        const scope = snapshot.scopes[i];
        lines.push('[' + scope.name + ']');
        if (!scope.variables || scope.variables.length === 0) {
          lines.push('  (empty)');
          lines.push('');
          continue;
        }
        appendSnapshotVariables(lines, scope.variables, 1, 3);
        lines.push('');
      }

      return lines.join('\\n');
    }

    function getSelectedBreakpointSnapshot() {
      if (!state.selectedBreakpointSnapshotId) return state.breakpointSnapshots[0] || null;
      return state.breakpointSnapshots.find(s => s.id === state.selectedBreakpointSnapshotId) || state.breakpointSnapshots[0] || null;
    }

    function renderBreakpointSnapshotsContent() {
      const snapshots = state.breakpointSnapshots || [];
      const count = snapshots.length;
      const selected = getSelectedBreakpointSnapshot();

      const header = \`
        <div class="section-label bp-section-label">
          <span>Breakpoint Snapshots</span>
          <span class="bp-count">\${count}</span>
          <button class="bp-clear-btn" id="btn-clear-breakpoint-snapshots" \${count === 0 ? 'disabled' : ''}>Clear</button>
        </div>
      \`;

      if (count === 0) {
        return header + '<div class="bp-empty">No breakpoint snapshots yet. When a breakpoint is hit, context will appear here.</div>';
      }

      const listHtml = snapshots.map(function(snapshot) {
        const selectedClass = selected && selected.id === snapshot.id ? ' selected' : '';
        const modeBadge = snapshot.autoResumed ? 'auto' : 'paused';
        return \`
          <button class="bp-item\${selectedClass}" data-breakpoint-snapshot-id="\${escape(snapshot.id)}"
            aria-label="Open breakpoint snapshot for \${escape(snapshot.appName)}">
            <span class="bp-item-top">
              <span class="bp-item-app">\${escape(snapshot.appName)}</span>
              <span class="bp-item-mode \${snapshot.autoResumed ? 'mode-auto' : 'mode-paused'}">\${modeBadge}</span>
            </span>
            <span class="bp-item-meta">\${escape(formatSnapshotLocation(snapshot))} • \${escape(formatSnapshotTimestamp(snapshot.createdAt))}</span>
          </button>
        \`;
      }).join('');

      const detailText = selected ? buildSnapshotDetailText(selected) : 'No snapshot selected.';

      return \`
        \${header}
        <div class="bp-grid">
          <div class="bp-list">\${listHtml}</div>
          <div class="bp-detail-wrap">
            <div class="bp-detail-title">Snapshot Detail</div>
            <pre class="bp-detail">\${escape(detailText)}</pre>
          </div>
        </div>
      \`;
    }

    function refreshBreakpointSnapshotsPanel() {
      const panel = document.getElementById('breakpoint-snapshots-panel');
      if (!panel) return;
      panel.innerHTML = renderBreakpointSnapshotsContent();
    }

    function renderBreakpointSnapshotsScreen() {
      const snapshotCount = state.breakpointSnapshots.length;
      const snapshotSummary = snapshotCount === 1
        ? '1 snapshot captured'
        : snapshotCount + ' snapshots captured';

      return \`
        <div class="ready-layout">
          <div class="step-header">
            <span class="step-title">Breakpoint Snapshots</span>
            <span class="radio-desc">\${escape(snapshotSummary)}</span>
          </div>
          <div id="breakpoint-snapshots-panel" class="bp-panel bp-panel-screen">\${renderBreakpointSnapshotsContent()}</div>
          <div class="footer" style="padding-top:0">
            <button class="btn bp-back-btn" id="btn-back-breakpoint-snapshots">&#8592; Back to Launcher</button>
          </div>
        </div>
      \`;
    }

    function refreshAppListSection() {
      const filtered = state.apps.filter(app =>
        !state.searchQuery || app.name.toLowerCase().includes(state.searchQuery.toLowerCase())
      );
      const started = filtered.filter(a => a.state === 'started').sort((a, b) => a.name.localeCompare(b.name));
      const stopped = filtered.filter(a => a.state === 'stopped' || a.state === 'empty').sort((a, b) => a.name.localeCompare(b.name));
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

    function renderAppBadge(app, isActive, isEmpty) {
      if (isActive) return \`<span class="badge badge-debug">debugging</span>\`;

      const hasCounts = hasInstanceCounts(app);
      const fallbackText = isEmpty ? 'started (0)' : app.state;
      const badgeText = hasCounts
        ? app.runningInstances + '/' + app.totalInstances
        : fallbackText;
      const badgeClass = app.state === 'started' ? 'started' : 'stopped';
      if (state.scalePendingAppName === app.name) {
        return \`<span class="badge badge-debug">scaling</span>\`;
      }
      if (canScaleAppInstances(app)) {
        const expanded = state.instanceScalePopover?.appName === app.name ? 'true' : 'false';
        return \`
          <button type="button" class="badge badge-\${badgeClass} badge-scale"
            data-scale-app="\${escape(app.name)}"
            aria-label="Scale \${escape(app.name)} instances (\${escape(badgeText)})"
            aria-expanded="\${expanded}">
            \${escape(badgeText)}
          </button>
        \`;
      }
      const disabledReason = hasCounts ? getScaleDisabledReason(app) : '';
      const titleAttr = disabledReason ? \` title="\${escape(disabledReason)}"\` : '';
      const disabledClass = disabledReason ? ' badge-scale-disabled' : '';
      return \`<span class="badge badge-\${badgeClass}\${disabledClass}"\${titleAttr}>\${escape(badgeText)}</span>\`;
    }

    function renderInstanceScalePopover(app) {
      if (state.instanceScalePopover?.appName !== app.name || !canScaleAppInstances(app)) return '';
      const current = app.totalInstances;
      const draft = getScaleDraftInstances(app);
      const bounds = getScaleDraftBounds(app);
      const decreaseDisabled = draft <= bounds.min ? 'disabled' : '';
      const increaseDisabled = draft >= bounds.max ? 'disabled' : '';
      const applyDisabled = draft === current ? 'disabled' : '';
      return \`
        <div class="scale-popover" role="dialog" aria-label="Scale \${escape(app.name)} instances">
          <div class="scale-popover-title">Instances</div>
          <div class="scale-stepper">
            <button type="button" class="scale-step-btn" data-scale-app="\${escape(app.name)}"
              data-scale-step="-1" aria-label="Decrease instances" \${decreaseDisabled}>&minus;</button>
            <span class="scale-count" aria-label="Target instances">\${draft}</span>
            <button type="button" class="scale-step-btn" data-scale-app="\${escape(app.name)}"
              data-scale-step="1" aria-label="Increase instances" \${increaseDisabled}>+</button>
          </div>
          <div class="scale-change">\${current} -&gt; \${draft}</div>
          <div class="scale-actions">
            <button type="button" class="scale-action" data-scale-app="\${escape(app.name)}"
              data-scale-cancel aria-label="Cancel instance scale">Cancel</button>
            <button type="button" class="scale-action primary" data-scale-app="\${escape(app.name)}"
              data-scale-apply aria-label="Apply instance scale" \${applyDisabled}>Apply</button>
          </div>
        </div>
      \`;
    }

    function renderAppRow(app) {
      const isActive = !!state.activeSessions[app.name];
      const isStopped = app.state === 'stopped';
      const isEmpty = app.state === 'empty';
      const isDisabled = isStopped || isEmpty || isActive;
      const isChecked = state.selectedApps.has(app.name) && !isDisabled;
      const rowClass = isActive ? 'in-debug' : (isStopped || isEmpty ? 'stopped' : '');
      const badge = renderAppBadge(app, isActive, isEmpty);
      const popover = renderInstanceScalePopover(app);
      return \`
        <div class="app-row \${rowClass}" data-app-row="\${escape(app.name)}">
          <input type="checkbox" data-app="\${escape(app.name)}"
            aria-label="Select \${escape(app.name)} for debug"
            \${isChecked ? 'checked' : ''}
            \${isDisabled ? 'disabled' : ''} />
          <span class="app-name" title="\${escape(app.name)}">\${escape(app.name)}</span>
          \${badge}
          \${popover}
        </div>
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
      const stopped = filtered.filter(a => a.state === 'stopped' || a.state === 'empty').sort((a, b) => a.name.localeCompare(b.name));

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
      const snapshotCount = state.breakpointSnapshots.length;
      const snapshotButtonLabel = snapshotCount > 0
        ? 'Breakpoint Snapshots (' + snapshotCount + ')'
        : 'Breakpoint Snapshots';
      const snapshotButton = state.debugPrefs.enableBreakpointSnapshotHandling
        ? \`
            <button class="header-nav-btn" id="btn-open-breakpoint-snapshots"
              title="Open breakpoint snapshots" aria-label="Open breakpoint snapshots">
              \${escape(snapshotButtonLabel)}
            </button>
          \`
        : '';

      return \`
        <div class="ready-layout">
          <div class="step-header ready-step-header">
            <span class="step-title">Debug Launcher</span>
            \${snapshotButton}
            <button class="gear-btn" id="btn-refresh-apps" title="Refresh app list" aria-label="Refresh apps" style="font-size:13px">&#8635;</button>
            <button class="gear-btn" id="btn-gear" title="Settings" aria-label="Open settings">&#9881;</button>
          </div>
          <div class="sr-only" aria-live="polite">\${escape(buildLiveStatus())}</div>
          \${state.error ? \`
            <div class="error-box">\${escape(state.error)}</div>
            <div style="height:6px"></div>
            <button class="btn btn-secondary" id="btn-retry-apps" style="margin-bottom:4px">&#8635; Retry</button>
          \` : ''}

          <div id="active-sessions-panel" style="flex-shrink:0">\${renderActiveSessionsContent()}</div>

          <div class="section-label" style="flex-shrink:0">Cloud Foundry</div>
          <div class="cf-info-box" style="flex-shrink:0">
            <div class="cf-info-row">
              <span class="cf-info-label">Region</span>
              <span class="cf-info-value" title="\${escape(state.apiEndpoint)}">\${escape(getRegionDisplay())}</span>
            </div>
            <div class="cf-info-row">
              <span class="cf-info-label">Org</span>
              <span class="cf-info-value" title="\${escape(state.selectedOrg ?? '')}">\${escape(state.selectedOrg ?? '')}</span>
            </div>
            <div class="cf-info-row">
              <span class="cf-info-label">Space</span>
              <span class="cf-info-value" title="\${escape(state.selectedSpace ?? '')}">\${escape(state.selectedSpace ?? '')}</span>
            </div>
          </div>
          <div style="height:8px;flex-shrink:0"></div>
          <input class="input" id="search-input" placeholder="Search apps&hellip;"
            aria-label="Search apps" value="\${escape(state.searchQuery)}" style="flex-shrink:0" />
          <div style="height:4px;flex-shrink:0"></div>
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

    function formatSyncSkipReason(reason) {
      const labels = {
        'no-credentials': 'credentials not set',
        'cache-disabled': 'cache is disabled',
        'lock-contention': 'another sync is running',
        'fatal-error': 'an error occurred',
        'aborted': 'sync was canceled',
      };
      return labels[reason] || 'an error occurred';
    }

    function isRetryableSyncSkipReason(reason) {
      return reason === 'aborted' || reason === 'fatal-error' || reason === 'lock-contention';
    }

    function renderCompletedSyncStatus(s) {
      const completedText = 'Last sync: <strong>' + escape(formatSyncTime(s.lastCompletedAt)) + '</strong>';
      if (!s.lastSkipReason) {
        return \`
          <div class="sync-status-row">
            <span style="color:var(--vscode-testing-iconPassed);margin-right:4px">&#9679;</span>
            <span>\${completedText}</span>
          </div>
        \`;
      }

      const attemptText = s.lastAttemptedAt
        ? ' · Last attempt ' + escape(formatSyncTime(s.lastAttemptedAt)) + ': '
        : ' · Last attempt: ';
      const retryText = state.cacheConfig.enabled && isRetryableSyncSkipReason(s.lastSkipReason)
        ? ' · retry scheduled automatically'
        : '';
      return \`
        <div class="sync-status-row warning">
          <span style="color:var(--vscode-inputValidation-warningForeground);margin-right:4px">&#9888;</span>
          <span>\${completedText}\${attemptText}\${escape(formatSyncSkipReason(s.lastSkipReason))}\${retryText}</span>
        </div>
      \`;
    }

    function renderWatchdogIntervalOptions(current) {
      const standard = [60, 90, 120, 300];
      const values = standard.slice();
      // A value set directly in VS Code settings may not be in the preset list —
      // keep it selectable instead of silently showing the wrong option.
      if (values.indexOf(current) === -1) values.push(current);
      values.sort(function(a, b) { return a - b; });
      return values.map(function(s) {
        const sel = current === s ? ' selected' : '';
        let label = s + ' seconds';
        if (s === 60) label = '1 minute';
        else if (s === 90) label = '90 seconds (default)';
        else if (s === 120) label = '2 minutes';
        else if (s === 300) label = '5 minutes';
        else if (standard.indexOf(s) === -1) label = s + ' seconds (custom)';
        return '<option value="' + s + '"' + sel + '>' + label + '</option>';
      }).join('');
    }

    function renderSettings() {
      const s = state.syncStatus;
      const c = state.cacheConfig;
      const w = state.appWatchdogConfig;
      const pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
      const progressText = s.isRunning
        ? (s.currentOrg
          ? 'Scanning ' + escape(s.currentRegion || '') + ' / ' + escape(s.currentOrg) + ' (' + s.done + '/' + s.total + ' \u00b7 ' + pct + '%)'
          : s.currentRegion
            ? 'Logging into ' + escape(s.currentRegion) + ' (' + s.done + '/' + s.total + ' \u00b7 ' + pct + '%)'
            : 'Initializing...')
        : '';

      const intervalOptions = [12, 24, 48, 96].map(function(h) {
        const sel = c.intervalHours === h ? ' selected' : '';
        let label = h + ' hours';
        if (h === 24) label = '1 day (default)';
        else if (h === 48) label = '2 days';
        else if (h === 96) label = '4 days';
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
        statusRow = renderCompletedSyncStatus(s);
      }

      // Credential section — shown differently based on source
      const credStatus = state.credentialStatus;
      var credSection;
      if (credStatus.source === 'env') {
        credSection = \`
          <div class="cred-info-row">
            <span class="cred-source-badge env">&#127981; env var</span>
            <span class="cred-info-email" title="\${escape(credStatus.email)}">\${escape(credStatus.email)}</span>
            <span class="cred-info-icon" tabindex="0" aria-label="Environment variable info">
              &#8505;
              <span class="cred-info-tooltip">Credentials are set via SAP_EMAIL / SAP_PASSWORD environment variables and will override any keychain entry. To use the credentials form instead, remove those variables from your shell profile (~/.zshrc, ~/.bashrc, etc.) and restart VS Code.</span>
            </span>
          </div>
        \`;
      } else if (credStatus.source === 'keychain') {
        credSection = \`
          <div class="cred-info-row">
            <span class="cred-source-badge keychain">&#128273; keychain</span>
            <span class="cred-info-email" title="\${escape(credStatus.email)}">\${escape(credStatus.email)}</span>
          </div>
          <div class="cred-btn-row">
            <button class="btn btn-secondary" id="btn-update-credentials">&#9998; Update</button>
            <button class="btn btn-secondary" id="btn-clear-credentials"
              style="color:var(--vscode-errorForeground)">&#10006; Clear</button>
          </div>
        \`;
      } else {
        credSection = \`
          <div class="radio-desc" style="margin-bottom:8px;color:var(--vscode-inputValidation-errorForeground)">
            No credentials configured.
          </div>
          <button class="btn" id="btn-update-credentials">&#128273; Set Credentials</button>
        \`;
      }

      return \`
        <div class="step-header">
          <span class="step-title">Settings</span>
        </div>

        <div class="section-label">SAP Credentials</div>
        \${credSection}

        <div class="divider" style="margin:10px 0"></div>

        <div class="section-label">Debug Behavior</div>

        <label class="pref-row" for="chk-open-browser">
          <div class="pref-row-content">
            <span class="pref-row-title">&#127758;&nbsp;Auto-open browser on attach
              <span class="pref-state-badge \${state.debugPrefs.openBrowserOnAttach ? 'pref-state-on' : 'pref-state-off'}">
                \${state.debugPrefs.openBrowserOnAttach ? 'enabled' : 'off by default'}
              </span>
            </span>
            <span class="pref-row-desc">When enabled, this extension opens the Chrome DevTools inspector the moment the debugger attaches. Disabled by default so the launcher stays focused until you opt in.</span>
          </div>
          <div class="toggle-switch \${state.debugPrefs.openBrowserOnAttach ? 'on' : ''}">
            <input type="checkbox" id="chk-open-browser" \${state.debugPrefs.openBrowserOnAttach ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </div>
        </label>

        <label class="pref-row" for="chk-breakpoint-snapshot-handling">
          <div class="pref-row-content">
            <span class="pref-row-title">Breakpoint snapshot handling
              <span class="pref-state-badge \${state.debugPrefs.enableBreakpointSnapshotHandling ? 'pref-state-on' : 'pref-state-off'}">
                \${state.debugPrefs.enableBreakpointSnapshotHandling ? 'enabled' : 'off by default'}
              </span>
            </span>
            <span class="pref-row-desc">Off by default. Turn this on to capture a snapshot and auto-continue; leave it off to keep native breakpoint pause behavior.</span>
          </div>
          <div class="toggle-switch \${state.debugPrefs.enableBreakpointSnapshotHandling ? 'on' : ''}">
            <input type="checkbox" id="chk-breakpoint-snapshot-handling" \${state.debugPrefs.enableBreakpointSnapshotHandling ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </div>
        </label>

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

        <div class="section-label">App Watchdog</div>

        <label class="pref-row" for="chk-watchdog-enabled">
          <div class="pref-row-content">
            <span class="pref-row-title">&#128737;&#65039;&nbsp;Watch debugged apps
              <span class="pref-state-badge \${w.enabled ? 'pref-state-on' : 'pref-state-off'}">
                \${w.enabled ? 'enabled' : 'disabled'}
              </span>
            </span>
            <span class="pref-row-desc">After <strong>Start Debug Sessions</strong>, ping each app's mapped route and show a status bar warning when it stops responding — e.g. a leftover breakpoint froze the remote app. Apps you are actively debugging are skipped while their session is alive. Each app is watched for 8 hours by default (<code>cdsDebug.appWatchdog.watchDurationHours</code> in VS Code settings).</span>
          </div>
          <div class="toggle-switch \${w.enabled ? 'on' : ''}">
            <input type="checkbox" id="chk-watchdog-enabled" \${w.enabled ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </div>
        </label>

        <div class="radio-desc" style="margin-bottom:4px">Ping interval</div>
        <select class="select" id="select-watchdog-interval" \${!w.enabled ? 'disabled' : ''}>
          \${renderWatchdogIntervalOptions(w.pingIntervalSeconds)}
        </select>

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
        <button class="btn btn-secondary" id="btn-trigger-sync" \${!c.enabled || s.isRunning ? 'disabled' : ''}>
          \${c.enabled && s.isRunning ? '&#8987; Syncing\u2026' : '&#8635; Sync Now'}
        </button>

        <div class="divider" style="margin:12px 0"></div>

        \${statusRow}
        <div style="height:10px"></div>
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

    // === CREDENTIAL SETUP SCREEN ===

    function renderSetupCredentials() {
      const isUpdate = state.credentialStatus.hasCredentials;
      const headerTitle = isUpdate ? 'Update Credentials' : 'Setup Credentials';
      const saveBtnLabel = state.isSavingCreds
        ? \`<span class="spinner" style="width:11px;height:11px;border-width:1.5px;margin-right:6px"></span>Saving\u2026\`
        : (isUpdate ? 'Update & Continue' : 'Save & Continue');

      const backBtn = isUpdate ? \`
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-cancel-creds">&#8592; Back to Settings</button>
      \` : \`
        <div class="divider" style="margin:16px 0 10px"></div>
        <div class="cred-env-hint">
          Alternatively, set <code>SAP_EMAIL</code> and <code>SAP_PASSWORD</code><br>
          environment variables in your shell profile.
        </div>
      \`;

      return \`
        <div class="step-header">
          <span class="step-title">\${escape(headerTitle)}</span>
        </div>
        <div class="info-box">
          Enter your SAP BTP credentials. They are stored securely in your
          system keychain (macOS Keychain, GNOME Keyring, or Windows Credential Manager).
        </div>
        \${state.credError ? \`<div class="error-box">\${escape(state.credError)}</div>\` : ''}
        <div class="section-label">Email</div>
        <input class="input" id="cred-email" type="email"
          placeholder="your.name@company.com"
          autocomplete="username"
          value="\${escape(state.setupCredEmail)}" />
        <div class="section-label" style="margin-top:10px">Password</div>
        <div class="input-password-wrap">
          <input class="input" id="cred-password" type="password"
            placeholder="Password"
            autocomplete="current-password" />
          <button class="btn-toggle-visibility" id="btn-toggle-pwd" type="button"
            aria-label="Toggle password visibility">&#128065;</button>
        </div>
        <div style="height:12px"></div>
        <button class="btn" id="btn-save-creds" \${state.isSavingCreds ? 'disabled' : ''}>\${saveBtnLabel}</button>
        \${backBtn}
      \`;
    }

    function attachCredentialListeners() {
      const $ = id => document.getElementById(id);

      $('btn-toggle-pwd')?.addEventListener('click', function() {
        const inp = $('cred-password');
        if (inp) {
          inp.type = inp.type === 'password' ? 'text' : 'password';
          const btn = $('btn-toggle-pwd');
          if (btn) btn.innerHTML = inp.type === 'password' ? '&#128065;' : '&#128065;&#65038;';
        }
      });

      $('btn-save-creds')?.addEventListener('click', function() {
        const emailInput = $('cred-email');
        const passwordInput = $('cred-password');
        const email = (emailInput ? emailInput.value : '').trim();
        const password = passwordInput ? passwordInput.value : '';

        if (!email) {
          state.credError = 'Email is required.';
          render(); return;
        }
        if (!email.includes('@')) {
          state.credError = 'Please enter a valid email address.';
          render(); return;
        }
        if (!password) {
          state.credError = 'Password is required.';
          render(); return;
        }

        state.credError = null;
        state.isSavingCreds = true;
        render();
        vscode.postMessage({ type: 'SAVE_CREDENTIALS', payload: { email, password } });
      });

      $('btn-cancel-creds')?.addEventListener('click', function() {
        state.credError = null;
        state.isSavingCreds = false;
        state.screen = SCREENS.SETTINGS;
        render();
      });

      // Allow Enter key to submit from either input
      [$('cred-email'), $('cred-password')].forEach(function(inp) {
        if (!inp) return;
        inp.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            const saveBtn = $('btn-save-creds');
            if (saveBtn && !saveBtn.disabled) saveBtn.click();
          }
        });
      });
    }

    function attachSettingsListeners() {
      const $ = id => document.getElementById(id);

      $('btn-gear')?.addEventListener('click', () => {
        state.screen = SCREENS.SETTINGS;
        vscode.postMessage({ type: 'GET_SYNC_STATUS' });
        vscode.postMessage({ type: 'GET_CACHE_CONFIG' });
        vscode.postMessage({ type: 'GET_APP_WATCHDOG_CONFIG' });
        vscode.postMessage({ type: 'GET_DEBUG_PREFS' });
        vscode.postMessage({ type: 'GET_CREDENTIALS_STATUS' });
        render();
      });

      $('btn-open-breakpoint-snapshots')?.addEventListener('click', () => {
        state.screen = SCREENS.BREAKPOINT_SNAPSHOTS;
        state.error = null;
        render();
      });

      $('btn-back-breakpoint-snapshots')?.addEventListener('click', () => {
        state.screen = SCREENS.READY;
        state.error = null;
        render();
      });

      $('chk-open-browser')?.addEventListener('change', function(e) {
        const openBrowserOnAttach = !!e.target.checked;
        state.debugPrefs = { ...state.debugPrefs, openBrowserOnAttach };
        updatePreferenceToggle('chk-open-browser', openBrowserOnAttach, openBrowserOnAttach ? 'enabled' : 'off by default');
        vscode.postMessage({ type: 'SAVE_DEBUG_PREFS', payload: state.debugPrefs });
      });

      $('chk-breakpoint-snapshot-handling')?.addEventListener('change', function(e) {
        const enableBreakpointSnapshotHandling = !!e.target.checked;
        state.debugPrefs = { ...state.debugPrefs, enableBreakpointSnapshotHandling };
        updatePreferenceToggle(
          'chk-breakpoint-snapshot-handling',
          enableBreakpointSnapshotHandling,
          enableBreakpointSnapshotHandling ? 'enabled' : 'off by default',
        );
        vscode.postMessage({ type: 'SAVE_DEBUG_PREFS', payload: state.debugPrefs });
      });

      $('chk-branch-prep')?.addEventListener('change', function(e) {
        const enableBranchPrep = !!e.target.checked;
        state.debugPrefs = { ...state.debugPrefs, enableBranchPrep };
        updatePreferenceToggle('chk-branch-prep', enableBranchPrep, '');
        vscode.postMessage({ type: 'SAVE_DEBUG_PREFS', payload: state.debugPrefs });
      });

      $('btn-back-settings')?.addEventListener('click', () => {
        state.screen = SCREENS.READY;
        state.error = null;
        render();
      });

      $('btn-logout-settings')?.addEventListener('click', () => {
        state.error = null;
        state.selectedTopologyOrg = null;
        state.pendingTopologyOrg = null;
        state.screen = SCREENS.REGION;
        render();
        vscode.postMessage({ type: 'RESET_LOGIN' });
      });

      $('chk-watchdog-enabled')?.addEventListener('change', function(e) {
        const enabled = !!e.target.checked;
        const select = document.getElementById('select-watchdog-interval');
        const pingIntervalSeconds = parseInt(select?.value || '90', 10);
        state.appWatchdogConfig = { enabled, pingIntervalSeconds };
        vscode.postMessage({ type: 'SAVE_APP_WATCHDOG_CONFIG', payload: state.appWatchdogConfig });
        render();
      });

      $('select-watchdog-interval')?.addEventListener('change', function(e) {
        const enabled = !!document.getElementById('chk-watchdog-enabled')?.checked;
        const pingIntervalSeconds = parseInt(e.target.value || '90', 10);
        state.appWatchdogConfig = { enabled, pingIntervalSeconds };
        vscode.postMessage({ type: 'SAVE_APP_WATCHDOG_CONFIG', payload: state.appWatchdogConfig });
        render();
      });

      $('chk-cache-enabled')?.addEventListener('change', function(e) {
        const selectEl = document.getElementById('select-interval');
        const enabled = !!e.target.checked;
        if (selectEl) selectEl.disabled = !enabled;
        const intervalHours = parseInt(selectEl?.value || '24', 10);
        vscode.postMessage({ type: 'SAVE_CACHE_CONFIG', payload: { enabled, intervalHours } });
        state.cacheConfig = { enabled, intervalHours };
        render();
      });

      $('select-interval')?.addEventListener('change', function(e) {
        const enabled = !!document.getElementById('chk-cache-enabled')?.checked;
        const intervalHours = parseInt(e.target.value || '24', 10);
        vscode.postMessage({ type: 'SAVE_CACHE_CONFIG', payload: { enabled, intervalHours } });
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

      $('btn-update-credentials')?.addEventListener('click', function() {
        state.setupCredEmail = '';
        state.credError = null;
        state.isSavingCreds = false;
        state.screen = SCREENS.SETUP_CREDENTIALS;
        render();
      });

      $('btn-clear-credentials')?.addEventListener('click', function() {
        vscode.postMessage({ type: 'CLEAR_CREDENTIALS' });
      });
    }
  `;
}
