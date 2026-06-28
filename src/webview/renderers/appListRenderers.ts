/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getAppListRenderersScript(): string {
  return `
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
  `;
}
