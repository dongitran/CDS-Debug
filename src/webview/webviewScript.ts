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
      INITIAL: 'initial',
      REGION: 'region',
      LOGGING_IN: 'logging-in',
      SELECT_ORG: 'select-org',
      SELECT_FOLDER: 'select-folder',
      LOADING_APPS: 'loading-apps',
      READY: 'ready',
      SETTINGS: 'settings',
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
      activeSessions: {}, // { appName: { status, message, msgPhase, intervalId } }
      syncStatus: { isRunning: false, lastCompletedAt: null, currentRegion: null, currentOrg: null, done: 0, total: 8 },
      cacheConfig: { enabled: true, intervalHours: 4 },
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
        case SCREENS.INITIAL:       return renderInitial();
        case SCREENS.REGION:        return renderRegion();
        case SCREENS.LOGGING_IN:    return renderLoggingIn();
        case SCREENS.SELECT_ORG:    return renderSelectOrg();
        case SCREENS.SELECT_FOLDER: return renderSelectFolder();
        case SCREENS.LOADING_APPS:  return renderLoadingApps();
        case SCREENS.READY:         return renderReady();
        case SCREENS.SETTINGS:      return renderSettings();
        default:                    return '';
      }
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

      // Settings screen listeners (defined in webviewRenderers.ts content)
      attachSettingsListeners();
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
