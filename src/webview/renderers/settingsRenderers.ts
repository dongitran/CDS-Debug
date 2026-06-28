/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getSettingsRenderersScript(): string {
  return `
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
      const p = state.sshProxyStatus;
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
        <div class="settings-wrapper" style="position: relative; flex: 1; min-height: 0; display: flex; margin-right: -12px;">
        <div class="settings-screen" id="settings-screen-scroll">
        <div class="step-header">
          <span class="step-title">Settings</span>
        </div>

        <div class="section-label">SAP Credentials</div>
        \${credSection}

        <div class="divider" style="margin:10px 0"></div>

        <div class="section-label">SSH Proxy</div>

        <label class="pref-row" for="chk-ssh-proxy-enabled">
          <div class="pref-row-content">
            <span class="pref-row-title">Use SSH proxy
              <span class="pref-state-badge \${p.enabled ? 'pref-state-on' : 'pref-state-off'}">
                \${p.enabled ? 'enabled' : 'disabled'}
              </span>
            </span>
          </div>
          <div class="toggle-switch \${p.enabled ? 'on' : ''}">
            <input type="checkbox" id="chk-ssh-proxy-enabled" \${p.enabled ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </div>
        </label>

        \${p.enabled ? \`
        <div class="ssh-proxy-grid">
          <label class="ssh-proxy-field" for="ssh-proxy-host">
            <span>Host / domain</span>
            <input class="input" id="ssh-proxy-host" value="\${escape(p.host)}" />
          </label>
          <label class="ssh-proxy-field ssh-proxy-port" for="ssh-proxy-port">
            <span>SSH port</span>
            <input class="input" id="ssh-proxy-port" type="number" min="1" max="65535" value="\${p.port}" />
          </label>
          <label class="ssh-proxy-field" for="ssh-proxy-username">
            <span>Username</span>
            <input class="input" id="ssh-proxy-username" value="\${escape(p.username)}" />
          </label>
          <label class="ssh-proxy-field" for="ssh-proxy-password">
            <span>Password</span>
            <input class="input" id="ssh-proxy-password" type="password"
              placeholder="\${p.hasPassword ? 'Stored in system keychain' : 'Required'}" />
          </label>
        </div>

        <div class="ssh-proxy-actions">
          <button class="btn" id="btn-save-ssh-proxy" \${p.connection === 'connecting' ? 'disabled' : ''}>
            \${p.connection === 'connecting' ? 'Testing...' : 'Save & Test'}
          </button>
          <button class="btn btn-secondary" id="btn-clear-ssh-proxy">Clear</button>
        </div>

        <div class="ssh-proxy-status \${p.connection === 'error' ? 'error' : p.connection === 'connected' ? 'connected' : ''}">
          \${p.connection === 'connected'
            ? 'Connected on 127.0.0.1:' + p.localPort
            : p.connection === 'connecting'
              ? 'Connecting...'
              : p.connection === 'error'
                ? escape(p.message || 'Connection failed.')
                : 'Not connected'}
        </div>
        \` : ''}

        <div class="divider" style="margin:12px 0"></div>

        <div class="section-label">Debug Behavior</div>

        <label class="pref-row" for="chk-open-browser">
          <div class="pref-row-content">
            <span class="pref-row-title">&#127758;&nbsp;Auto-open browser on attach
              <span class="pref-state-badge \${state.debugPrefs.openBrowserOnAttach ? 'pref-state-on' : 'pref-state-off'}">
                \${state.debugPrefs.openBrowserOnAttach ? 'enabled' : 'off by default'}
              </span>
            </span>
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
          </div>
          <div class="toggle-switch \${state.debugPrefs.enableBreakpointSnapshotHandling ? 'on' : ''}">
            <input type="checkbox" id="chk-breakpoint-snapshot-handling" \${state.debugPrefs.enableBreakpointSnapshotHandling ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </div>
        </label>

        <label class="pref-row" for="chk-branch-prep">
          <div class="pref-row-content">
            <span class="pref-row-title">Branch auto-checkout <span class="beta-badge">experimental</span></span>
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
        </div>
        <div class="faux-scrollbar" style="position: absolute; right: 0; top: 0; bottom: 0; width: 12px; pointer-events: none; z-index: 10;">
          <div class="faux-scrollbar-thumb" style="width: 6px; border-radius: 3px; background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.5)); position: absolute; right: 2px; top: 0; transition: background 0.2s;"></div>
        </div>
        </div>
      \`;
    }

    function attachSettingsListeners() {
      const $ = id => document.getElementById(id);

      // Faux scrollbar logic for the settings screen
      const scrollEl = $('settings-screen-scroll');
      if (scrollEl) {
        const thumbEl = document.querySelector('.faux-scrollbar-thumb');
        const syncScrollbar = () => {
          if (!thumbEl) return;
          const ratio = scrollEl.clientHeight / scrollEl.scrollHeight;
          if (ratio >= 1 || scrollEl.clientHeight === 0) {
            thumbEl.style.display = 'none';
          } else {
            thumbEl.style.display = 'block';
            const minThumbHeight = 20;
            const thumbHeight = Math.max(minThumbHeight, scrollEl.clientHeight * ratio);
            const scrollProgress = scrollEl.scrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight);
            const top = scrollProgress * (scrollEl.clientHeight - thumbHeight);
            thumbEl.style.height = thumbHeight + 'px';
            thumbEl.style.top = top + 'px';
          }
        };
        scrollEl.addEventListener('scroll', syncScrollbar);
        window.addEventListener('resize', syncScrollbar);
        // Use ResizeObserver to catch changes when toggles expand/collapse content
        if (window.ResizeObserver) {
          const observer = new ResizeObserver(syncScrollbar);
          observer.observe(scrollEl);
        }
        // Initial sync
        setTimeout(syncScrollbar, 0);
      }

      $('btn-gear')?.addEventListener('click', () => {
        state.screen = SCREENS.SETTINGS;
        vscode.postMessage({ type: 'GET_SYNC_STATUS' });
        vscode.postMessage({ type: 'GET_CACHE_CONFIG' });
        vscode.postMessage({ type: 'GET_APP_WATCHDOG_CONFIG' });
        vscode.postMessage({ type: 'GET_DEBUG_PREFS' });
        vscode.postMessage({ type: 'GET_CREDENTIALS_STATUS' });
        vscode.postMessage({ type: 'GET_SSH_PROXY_STATUS' });
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

      $('chk-ssh-proxy-enabled')?.addEventListener('change', function(e) {
        const enabled = !!e.target.checked;
        const previous = state.sshProxyStatus;
        state.sshProxyStatus = {
          ...previous,
          enabled,
          connection: enabled ? 'disconnected' : 'disabled',
          message: null,
        };
        if (!enabled && previous.host && previous.username) {
          vscode.postMessage({
            type: 'SAVE_SSH_PROXY_SETTINGS',
            payload: {
              enabled: false,
              host: previous.host,
              port: previous.port,
              username: previous.username,
            },
          });
        }
        render();
      });

      $('btn-save-ssh-proxy')?.addEventListener('click', function() {
        const host = String($('ssh-proxy-host')?.value || '').trim();
        const port = parseInt(String($('ssh-proxy-port')?.value || ''), 10);
        const username = String($('ssh-proxy-username')?.value || '').trim();
        const password = String($('ssh-proxy-password')?.value || '');
        if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
          state.sshProxyStatus = {
            ...state.sshProxyStatus,
            connection: 'error',
            message: 'Enter a valid host, SSH port, and username.',
          };
          render();
          return;
        }
        state.sshProxyStatus = {
          ...state.sshProxyStatus,
          enabled: true,
          host,
          port,
          username,
          connection: 'connecting',
          message: null,
        };
        const payload = { enabled: true, host, port, username };
        if (password) payload.password = password;
        vscode.postMessage({ type: 'SAVE_SSH_PROXY_SETTINGS', payload });
        render();
      });

      $('btn-clear-ssh-proxy')?.addEventListener('click', function() {
        vscode.postMessage({ type: 'CLEAR_SSH_PROXY_SETTINGS' });
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
