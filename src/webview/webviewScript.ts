/**
 * Client-side JavaScript framework for the CDS Debug Launcher webview.
 * Render functions live in webviewRenderers.ts and are injected at build time.
 * Runs in the VS Code webview browser context — no ES module imports allowed.
 * Sections: CONSTANTS → STATE → UTILS → RENDERERS → LISTENERS → MESSAGE HANDLER → INIT
 */
import { getRendererScriptContent } from './webviewRenderers';

export function getScript(nonce: string): string {
  return `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // === CONSTANTS ===

    const SCREENS = {
      SETUP_CREDENTIALS: 'setup-credentials',
      REGION: 'region',
      LOGGING_IN: 'logging-in',
      SELECT_ORG: 'select-org',
      SELECT_FOLDER: 'select-folder',
      LOADING_APPS: 'loading-apps',
      READY: 'ready',
      SETTINGS: 'settings',
      PREPARING_BRANCHES: 'preparing-branches',
    };

    const CF_REGIONS = [
      { code: 'us10', name: 'US East (VA)' },
      { code: 'us11', name: 'US East (us11)' },
      { code: 'us20', name: 'US West (WA)' },
      { code: 'us21', name: 'US West (us21)' },
      { code: 'us30', name: 'US Central (Iowa)' },
      { code: 'eu10', name: 'Europe (Frankfurt)' },
      { code: 'eu20', name: 'Europe (Amsterdam)' },
      { code: 'eu30', name: 'Europe (Frankfurt) GCP' },
      { code: 'ch20', name: 'Switzerland (Zürich)' },
      { code: 'ap10', name: 'Australia (Sydney)' },
      { code: 'ap11', name: 'Singapore' },
      { code: 'ap12', name: 'South Korea (Seoul)' },
      { code: 'ap20', name: 'APJ (Osaka)' },
      { code: 'ap21', name: 'Singapore (Azure)' },
      { code: 'jp10', name: 'Japan (Tokyo)' },
      { code: 'jp20', name: 'Japan (Osaka)' },
      { code: 'in30', name: 'India (Mumbai)' },
      { code: 'br10', name: 'Brazil (São Paulo)' },
      { code: 'ca10', name: 'Canada (Montreal)' },
      { code: 'ca20', name: 'Canada (Toronto)' },
    ];

    const LOADING_MESSAGES = [
      "Opening SSH tunnel...",
      "Mapping local ports...",
      "Waiting for trace route...",
      "Establishing connection..."
    ];

    // === STATE ===

    let state = {
      screen: SCREENS.REGION,
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
      activeSessions: {}, // { appName: { status, message, msgPhase, intervalId } }
      syncStatus: { isRunning: false, lastCompletedAt: null, currentRegion: null, currentOrg: null, done: 0, total: 14 },
      cacheConfig: { enabled: true, intervalHours: 24 },
      // Branch preparation state: [{ appName, targetBranch, currentBranch, step, message }]
      branchPrepServices: [],
      // Debug behavior preferences
      debugPrefs: { openBrowserOnAttach: false, enableBranchPrep: false },
      // True when the current LOAD_APPS was triggered automatically by session restore
      // (VS Code restart). Used to determine whether APPS_ERROR should auto-reconnect.
      isRestoringSession: false,
      // True when auto-reconnect was triggered (shows different spinner message).
      isReconnecting: false,
      // Credential setup screen state
      credentialStatus: { hasCredentials: false, email: '', source: 'none' },
      setupCredEmail: '',
      credError: null,
      isSavingCreds: false,
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

    // === RENDERERS (injected) ===

    ${getRendererScriptContent()}

    function render() {
      document.getElementById('app').innerHTML = renderScreen();
      attachListeners();
    }

    function renderScreen() {
      switch (state.screen) {
        case SCREENS.SETUP_CREDENTIALS:   return renderSetupCredentials();
        case SCREENS.REGION:              return renderRegion();
        case SCREENS.LOGGING_IN:          return renderLoggingIn();
        case SCREENS.SELECT_ORG:          return renderSelectOrg();
        case SCREENS.SELECT_FOLDER:       return renderSelectFolder();
        case SCREENS.LOADING_APPS:        return renderLoadingApps();
        case SCREENS.READY:               return renderReady();
        case SCREENS.SETTINGS:            return renderSettings();
        case SCREENS.PREPARING_BRANCHES:  return renderPreparingBranches();
        default:                          return '';
      }
    }

    // === LISTENERS ===

    function attachListeners() {
      const $ = id => document.getElementById(id);

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

      document.querySelectorAll('input[name="cf-org"]').forEach(el => {
        el.addEventListener('change', e => {
          state.selectedOrg = e.target.value;
          // Patch classes in-place — calling render() resets scroll position
          document.querySelectorAll('label.org-item').forEach(label => {
            const inp = label.querySelector('input[name="cf-org"]');
            if (inp) label.classList.toggle('selected', inp.value === state.selectedOrg);
          });
          const nextBtn = document.getElementById('btn-next-org');
          if (nextBtn) nextBtn.removeAttribute('disabled');
        });
      });

      $('btn-next-org')?.addEventListener('click', () => {
        state.error = null;
        state.screen = SCREENS.SELECT_FOLDER;
        render();
      });

      $('btn-browse-folder')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'SELECT_GROUP_FOLDER' });
      });

      $('btn-save-mapping')?.addEventListener('click', () => {
        if (!state.selectedOrg || !state.selectedFolder) return;
        const mappings = [{ cfOrg: state.selectedOrg, groupFolderPath: state.selectedFolder }];
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
          const stopAllBtn = e.target.closest('#btn-stop-all-sessions');
          if (stopAllBtn) {
            vscode.postMessage({ type: 'STOP_ALL_DEBUG' });
            return;
          }
          const stopBtn = e.target.closest('[data-stop-app]');
          if (stopBtn) {
            vscode.postMessage({ type: 'STOP_DEBUG', payload: { appName: stopBtn.dataset.stopApp } });
            return;
          }
          const retryBtn = e.target.closest('[data-retry-app]');
          if (retryBtn) {
            vscode.postMessage({ type: 'RETRY_DEBUG', payload: { appName: retryBtn.dataset.retryApp } });
            return;
          }
          const openBtn = e.target.closest('[data-open-url]');
          if (openBtn) {
            vscode.postMessage({ type: 'OPEN_APP_URL', payload: { url: openBtn.dataset.openUrl, source: 'manual' } });
          }
        });
      }

      $('btn-refresh-apps')?.addEventListener('click', () => {
        if (!state.selectedOrg) return;
        state.error = null;
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
      });

      $('chk-select-all')?.addEventListener('change', function(e) {
        const selectableStarted = state.apps.filter(a => a.state === 'started' && !state.activeSessions[a.name]);
        if (e.target.checked) {
          selectableStarted.forEach(a => state.selectedApps.add(a.name));
        } else {
          selectableStarted.forEach(a => state.selectedApps.delete(a.name));
        }
        refreshAppListSection();
      });

      $('btn-start-debug')?.addEventListener('click', () => {
        const appNames = [...state.selectedApps].filter(
          n => state.apps.find(a => a.name === n && a.state === 'started') && !state.activeSessions[n]
        );
        if (appNames.length === 0) return;
        // Optimistic update: immediately disable selected apps and show pending
        // active-session cards so the UI responds instantly even on slow networks
        // (cfTarget() and folder resolution in handleStartDebug can take seconds).
        appNames.forEach(n => {
          state.selectedApps.delete(n);
          state.activeSessions[n] = { status: 'PENDING', msgPhase: 0 };
        });
        refreshActiveSessionsPanel();
        refreshAppListSection();
        vscode.postMessage({ type: 'START_DEBUG', payload: { appNames, org: state.selectedOrg } });
      });

      $('btn-remap')?.addEventListener('click', () => {
        if (Object.keys(state.activeSessions).length > 0) {
          vscode.postMessage({ type: 'REQUEST_CHANGE_MAPPING' });
        } else {
          state.screen = SCREENS.SELECT_ORG; 
          state.error = null; 
          render();
        }
      });

      $('btn-retry-apps')?.addEventListener('click', () => {
        if (!state.selectedOrg) return;
        state.error = null;
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
      });

      $('btn-cancel-login')?.addEventListener('click', () => {
        state.screen = SCREENS.REGION;
        state.error = null;
        render();
      });

      $('btn-cancel-load-apps')?.addEventListener('click', () => {
        state.screen = state.apps.length > 0 ? SCREENS.READY : SCREENS.SELECT_FOLDER;
        state.error = null;
        render();
      });

      // Settings screen listeners (defined in webviewRenderers.ts content)
      attachSettingsListeners();
      // Credential setup screen listeners (defined in webviewRenderers.ts content)
      attachCredentialListeners();
    }

    // === MESSAGE HANDLER ===

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'GROUP_FOLDER_SELECTED':
          state.selectedFolder = msg.payload.path;
          render();
          break;
        case 'PROCEED_CHANGE_MAPPING':
          state.screen = SCREENS.SELECT_ORG;
          state.error = null;
          render();
          return;
        case 'LOGIN_SUCCESS':
          state.orgs = msg.payload.orgs;
          state.isReconnecting = false;
          state.screen = SCREENS.SELECT_ORG;
          state.error = null;
          break;
        case 'LOGIN_ERROR':
          state.isReconnecting = false;
          state.error = msg.payload.message;
          state.screen = SCREENS.REGION;
          break;
        case 'APPS_LOADED':
          state.apps = msg.payload.apps;
          state.selectedApps = new Set();
          state.isRestoringSession = false;
          state.screen = SCREENS.READY;
          state.error = null;
          break;
        case 'APPS_ERROR':
          // If this error happened during session restore (VS Code restart), the CF
          // session token is likely expired. Auto-reconnect using the saved endpoint
          // so user lands on SELECT_ORG with a fresh org list instead of a broken
          // READY screen.
          if (state.isRestoringSession && state.apiEndpoint) {
            state.isRestoringSession = false;
            state.isReconnecting = true;
            state.error = null;
            state.screen = SCREENS.LOGGING_IN;
            render();
            vscode.postMessage({ type: 'LOGIN', payload: { apiEndpoint: state.apiEndpoint } });
            return;
          }
          state.error = msg.payload.message;
          state.screen = SCREENS.READY;
          break;
        case 'BRANCH_PREP_START': {
          state.branchPrepServices = msg.payload.services.map(function(s) {
            return { appName: s.appName, targetBranch: s.targetBranch, currentBranch: s.currentBranch, step: 'pending', message: null };
          });
          state.screen = SCREENS.PREPARING_BRANCHES;
          break;
        }
        case 'BRANCH_PREP_STATUS': {
          const svc = state.branchPrepServices.find(function(s) { return s.appName === msg.payload.appName; });
          if (svc) {
            svc.step = msg.payload.step;
            if (msg.payload.message) svc.message = msg.payload.message;
          }
          if (state.screen === SCREENS.PREPARING_BRANCHES) render();
          return;
        }
        case 'DEBUG_CONNECTING': {
          let needFullRender = false;
          // If coming from branch prep screen, transition back to ready
          if (state.screen === SCREENS.PREPARING_BRANCHES) {
            state.screen = SCREENS.READY;
            state.branchPrepServices = [];
            needFullRender = true;
          }
          const noLocalFolderSet = new Set(msg.payload.unmappedApps || []);
          msg.payload.appNames.forEach(appName => {
            const port = (msg.payload.ports || {})[appName];
            state.activeSessions[appName] = { status: 'TUNNELING', msgPhase: 0, port, noLocalFolder: noLocalFolderSet.has(appName) };
            const tId = setInterval(() => {
              if (state.activeSessions[appName]?.status === 'TUNNELING') {
                state.activeSessions[appName].msgPhase =
                  (state.activeSessions[appName].msgPhase + 1) % LOADING_MESSAGES.length;
                updateActiveCardStatusOnly(appName);
              }
            }, 1800);
            state.activeSessions[appName].intervalId = tId;
          });
          
          if (needFullRender) {
            render();
          } else {
            refreshActiveSessionsPanel();
            refreshAppListSection();
          }
          return;
        }
        case 'APP_DEBUG_STATUS': {
          const { appName, status, message } = msg.payload;
          if (status === 'EXITED') {
            const session = state.activeSessions[appName];
            if (session?.intervalId) clearInterval(session.intervalId);
            delete state.activeSessions[appName];
            refreshActiveSessionsPanel();
            refreshAppListSection();
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
          refreshAppListSection();
          return;
        }
        case 'DEBUG_ERROR':
          // Clear any optimistically-added PENDING sessions — the start request
          // failed before any tunnel was established (e.g. cfTarget network error).
          for (const appName of Object.keys(state.activeSessions)) {
            if (state.activeSessions[appName].status === 'PENDING') {
              delete state.activeSessions[appName];
            }
          }
          state.error = msg.payload.message;
          state.screen = SCREENS.READY;
          break;
        case 'SYNC_STATUS':
          state.syncStatus = msg.payload;
          // Only re-render if the user is on the settings screen; otherwise
          // the updated status will be picked up next time they open settings.
          if (state.screen === SCREENS.SETTINGS) render();
          return;
        case 'CACHE_CONFIG':
          state.cacheConfig = msg.payload;
          if (state.screen === SCREENS.SETTINGS) render();
          return;
        case 'DEBUG_PREFS':
          state.debugPrefs = msg.payload;
          // Always sync both panels so active-session cards and the app-list
          // (which grays-out apps currently being debugged) stay consistent
          // whenever prefs are pushed from the extension.
          refreshActiveSessionsPanel();
          refreshAppListSection();
          // Do NOT call render() here — the Settings UI updates its checkbox in-place
          // and render() would rebuild the full DOM, accumulating duplicate listeners
          // on every subsequent toggle.
          return;
        case 'CONFIG_LOADED': {
          // Always update credential status first — used to decide initial screen.
          if (msg.payload.credentialStatus) {
            state.credentialStatus = msg.payload.credentialStatus;
          }

          const cfg = msg.payload.config;
          if (cfg) {
            state.apiEndpoint = cfg.apiEndpoint;
            const detectedRegion = endpointToRegion(cfg.apiEndpoint);
            if (detectedRegion && CF_REGIONS.some(r => r.code === detectedRegion)) {
              state.selectedRegion = detectedRegion;
              state.useCustomEndpoint = false;
            } else if (cfg.apiEndpoint) {
              state.useCustomEndpoint = true;
            }
            const restoredSessions = msg.payload.activeSessions ?? {};
            for (const [appName, session] of Object.entries(restoredSessions)) {
              if (session.status === 'TUNNELING') {
                session.msgPhase = session.msgPhase || 0;
                const tId = setInterval(() => {
                  if (state.activeSessions[appName]?.status === 'TUNNELING') {
                    state.activeSessions[appName].msgPhase =
                      (state.activeSessions[appName].msgPhase + 1) % LOADING_MESSAGES.length;
                    updateActiveCardStatusOnly(appName);
                  }
                }, 1800);
                session.intervalId = tId;
              }
            }
            state.activeSessions = restoredSessions;
            state.orgs = cfg.orgs ?? [];
            state.mappings = cfg.orgGroupMappings;
          }

          // Gate: require credentials before proceeding with any other screen.
          if (!state.credentialStatus.hasCredentials) {
            state.screen = SCREENS.SETUP_CREDENTIALS;
            break;
          }

          if (cfg && state.mappings.length > 0) {
            state.selectedOrg = state.mappings[0].cfOrg;
            state.selectedFolder = state.mappings[0].groupFolderPath;
            // Mark as restoring so APPS_ERROR can trigger auto-reconnect instead
            // of leaving the user stuck on a broken READY screen.
            state.isRestoringSession = true;
            state.screen = SCREENS.LOADING_APPS;
            render();
            vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
            return;
          }

          state.screen = SCREENS.REGION;
          break;
        }

        case 'CREDENTIALS_SAVED': {
          state.isSavingCreds = false;
          state.credError = null;
          state.credentialStatus = {
            hasCredentials: true,
            email: msg.payload.email,
            source: msg.payload.source,
          };
          if (state.screen === SCREENS.SETUP_CREDENTIALS) {
            // If saved config had mappings, restore the session; else go to REGION.
            if (state.mappings && state.mappings.length > 0) {
              state.selectedOrg = state.mappings[0].cfOrg;
              state.selectedFolder = state.mappings[0].groupFolderPath;
              state.isRestoringSession = true;
              state.screen = SCREENS.LOADING_APPS;
              render();
              vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg } });
              return;
            }
            state.screen = SCREENS.REGION;
          }
          break;
        }

        case 'CREDENTIALS_ERROR': {
          state.isSavingCreds = false;
          state.credError = msg.payload.message;
          if (state.screen !== SCREENS.SETUP_CREDENTIALS) return;
          break;
        }

        case 'CREDENTIALS_STATUS': {
          const prevHad = state.credentialStatus.hasCredentials;
          state.credentialStatus = msg.payload;
          // After clearing credentials: if no credentials remain, redirect to setup.
          if (prevHad && !msg.payload.hasCredentials) {
            state.credError = null;
            state.isSavingCreds = false;
            state.screen = SCREENS.SETUP_CREDENTIALS;
            break;
          }
          if (state.screen === SCREENS.SETTINGS) render();
          return;
        }

        case 'CREDENTIALS_REVOKED': {
          // Auth failure with keychain creds — extension already cleared them.
          // Redirect to setup screen so user can enter updated credentials.
          state.credError = msg.payload.message;
          state.isSavingCreds = false;
          state.credentialStatus = { hasCredentials: false, email: '', source: 'none' };
          state.screen = SCREENS.SETUP_CREDENTIALS;
          break;
        }
      }
      render();
    });

    // === INIT ===

    // Belt-and-suspenders: always request fresh prefs from globalState at startup.
    // LOAD_CONFIG handler also pushes DEBUG_PREFS, but this handles rare timing
    // races where acquireVsCodeApi() state held a stale openBrowserOnAttach:true
    // value from a previous VS Code session.
    vscode.postMessage({ type: 'GET_DEBUG_PREFS' });
    vscode.postMessage({ type: 'LOAD_CONFIG' });
    render();
  </script>`;
}
