/**
 * Client-side JavaScript framework for the CDS Debug Launcher webview.
 * Render functions live in webviewRenderers.ts and are injected at build time.
 * Runs in the VS Code webview browser context — no ES module imports allowed.
 * Sections: CONSTANTS → STATE → UTILS → RENDERERS → LISTENERS → MESSAGE HANDLER → INIT
 */
import { getRendererScriptContent } from './webviewRenderers';
import { getPackageBrowserScriptContent } from './packageBrowserContent';
import { getAllRegions } from '@saptools/cf-sync';
import { selectPreferredOrgMapping, upsertWebviewOrgMapping } from './mappingState';

interface WebviewCfRegion {
  readonly code: string;
  readonly name: string;
  readonly label: string;
  readonly apiEndpoint: string;
}

function removeRegionKeySuffix(label: string, code: string): string {
  const suffix = ` (${code})`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

// cf-sync can lag SAP's published landscape table; keep UI-only additions here
// so login/debug can target newer endpoints without passing unsupported keys to cf-sync.
const ADDITIONAL_WEBVIEW_CF_REGIONS = [
  {
    code: 'eu10-002',
    name: 'Europe (Frankfurt) - AWS',
    label: 'Europe (Frankfurt) - AWS (eu10-002)',
    apiEndpoint: 'https://api.cf.eu10-002.hana.ondemand.com',
  },
  {
    code: 'eu10-003',
    name: 'Europe (Frankfurt) - AWS',
    label: 'Europe (Frankfurt) - AWS (eu10-003)',
    apiEndpoint: 'https://api.cf.eu10-003.hana.ondemand.com',
  },
  {
    code: 'eu10-004',
    name: 'Europe (Frankfurt) - AWS',
    label: 'Europe (Frankfurt) - AWS (eu10-004)',
    apiEndpoint: 'https://api.cf.eu10-004.hana.ondemand.com',
  },
  {
    code: 'eu10-005',
    name: 'Europe (Frankfurt) - AWS',
    label: 'Europe (Frankfurt) - AWS (eu10-005)',
    apiEndpoint: 'https://api.cf.eu10-005.hana.ondemand.com',
  },
  {
    code: 'eu20-001',
    name: 'Europe (Netherlands) - Azure',
    label: 'Europe (Netherlands) - Azure (eu20-001)',
    apiEndpoint: 'https://api.cf.eu20-001.hana.ondemand.com',
  },
  {
    code: 'eu20-002',
    name: 'Europe (Netherlands) - Azure',
    label: 'Europe (Netherlands) - Azure (eu20-002)',
    apiEndpoint: 'https://api.cf.eu20-002.hana.ondemand.com',
  },
  {
    code: 'us10-001',
    name: 'US East (VA) - AWS',
    label: 'US East (VA) - AWS (us10-001)',
    apiEndpoint: 'https://api.cf.us10-001.hana.ondemand.com',
  },
  {
    code: 'us10-002',
    name: 'US East (VA) - AWS',
    label: 'US East (VA) - AWS (us10-002)',
    apiEndpoint: 'https://api.cf.us10-002.hana.ondemand.com',
  },
  {
    code: 'us10-004',
    name: 'US East (VA) - AWS',
    label: 'US East (VA) - AWS (us10-004)',
    apiEndpoint: 'https://api.cf.us10-004.hana.ondemand.com',
  },
] as const satisfies readonly WebviewCfRegion[];

const WEBVIEW_CF_REGIONS: readonly WebviewCfRegion[] = [
  ...getAllRegions().map((region) => ({
    code: region.key,
    name: removeRegionKeySuffix(region.label, region.key),
    label: region.label,
    apiEndpoint: region.apiEndpoint,
  })),
  ...ADDITIONAL_WEBVIEW_CF_REGIONS,
]
  .filter((region, index, regions) => (
    regions.findIndex((candidate) => candidate.code === region.code) === index
  ))
  .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));

const WEBVIEW_CF_REGIONS_JSON = JSON.stringify(WEBVIEW_CF_REGIONS);

export function getScript(nonce: string): string {
  return `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    window.__cdsDebugPostMessage = function(message) {
      vscode.postMessage(message);
    };

    // === CONSTANTS ===

    const SCREENS = {
      SETUP_CREDENTIALS: 'setup-credentials',
      REGION: 'region',
      LOGGING_IN: 'logging-in',
      SELECT_ORG: 'select-org',
      LOADING_SPACES: 'loading-spaces',
      SELECT_SPACE: 'select-space',
      SELECT_FOLDER: 'select-folder',
      LOADING_APPS: 'loading-apps',
      READY: 'ready',
      PACKAGES: 'packages',
      PACKAGE_SETTINGS: 'package-settings',
      BREAKPOINT_SNAPSHOTS: 'breakpoint-snapshots',
      SETTINGS: 'settings',
      PREPARING_BRANCHES: 'preparing-branches',
    };

    const CF_REGIONS = ${WEBVIEW_CF_REGIONS_JSON};

    const LOADING_MESSAGES = [
      "Opening SSH tunnel...",
      "Mapping local ports...",
      "Waiting for trace route...",
      "Establishing connection..."
    ];

    ${selectPreferredOrgMapping.toString()}
    ${upsertWebviewOrgMapping.toString()}

    // === STATE ===

    let state = {
      screen: SCREENS.REGION,
      apiEndpoint: '',
      selectedRegion: 'eu10',
      useCustomEndpoint: false,
      orgs: [],
      mappings: [],
      selectedOrg: null,
      spacesByOrg: {},
      selectedSpace: null,
      selectedFolder: null,
      // Per-target folder cache: { [JSON.stringify([cfOrg, cfSpace])]: groupFolderPath }
      // Populated from saved orgGroupMappings on CONFIG_LOADED and updated whenever the
      // user confirms a folder. Enables auto-restoring the previously selected folder
      // when the user switches back to an org/space they have used before.
      foldersByTarget: {},
      apps: [],
      selectedApps: new Set(),
      searchQuery: '',
      error: null,
      activeSessions: {}, // { appName: { status, message, msgPhase, intervalId } }
      syncStatus: { isRunning: false, lastCompletedAt: null, currentRegion: null, currentOrg: null, done: 0, total: 0 },
      cacheConfig: { enabled: true, intervalHours: 24 },
      // Branch preparation state: [{ appName, targetBranch, currentBranch, step, message }]
      branchPrepServices: [],
      // Debug behavior preferences
      debugPrefs: {
        openBrowserOnAttach: false,
        enableBreakpointSnapshotHandling: false,
        enableBranchPrep: false,
      },
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
      breakpointSnapshots: [],
      selectedBreakpointSnapshotId: null,
      packageBrowserAppName: null,
      packageBaseEntries: [],
      packageEntries: [],
      packageBrowserSearchQuery: '',
      packageBrowserLoading: false,
      packageBrowserError: null,
      packageSearchRequestId: 0,
      packageSearchPending: false,
      expandedPackageBranchIds: [],
      searchPackageBranchStates: {},
      selectedPackageFileId: null,
      debugSessionPackagePrefs: {
        packageNameFilterRegex: '',
      },
      packageSettingsDraftRegex: '',
      packageSettingsError: null,
      // Cross-region org topology populated from cf-sync's structure file. Powers
      // the Org tab shown on the CF Region / Org step.
      cfTopology: { ready: false, accounts: [] },
      orgSearchQuery: '',
      regionSearchQuery: '',
      regionSelectorMode: 'org',
      selectedTopologyOrg: null,
      // region/org pair the user picked from the search; consumed by LOGIN_SUCCESS
      // to skip Step 2/3 (Select Org) when the live org list still contains it.
      pendingTopologyOrg: null,
    };

    // === UTILS ===

    function escape(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function normalizeEndpointValue(endpoint) {
      return String(endpoint || '').trim().replace(new RegExp('/+$'), '');
    }

    function findRegionByCode(code) {
      return CF_REGIONS.find(region => region.code === code) || null;
    }

    function regionToEndpoint(code) {
      const region = findRegionByCode(code);
      return region ? region.apiEndpoint : 'https://api.cf.' + code + '.hana.ondemand.com';
    }

    function endpointToRegion(endpoint) {
      const normalized = normalizeEndpointValue(endpoint);
      const region = CF_REGIONS.find(r => normalizeEndpointValue(r.apiEndpoint) === normalized);
      if (region) return region.code;

      const hanaMatch = normalized.match(new RegExp('api[.]cf[.]([^.]+)[.]hana[.]ondemand[.]com'));
      if (hanaMatch) return hanaMatch[1];

      const chinaMatch = normalized.match(new RegExp('api[.]cf[.]([^.]+)[.]platform[.]sapcloud[.]cn'));
      return chinaMatch ? chinaMatch[1] : null;
    }

    function getRegionDisplay() {
      if (state.useCustomEndpoint) {
        const code = endpointToRegion(state.apiEndpoint);
        return code ? code + ' (custom)' : state.apiEndpoint;
      }
      const region = CF_REGIONS.find(r => r.code === state.selectedRegion);
      return region ? state.selectedRegion + ' \u2014 ' + region.name : state.selectedRegion;
    }

    function mappingSpace(mapping) {
      return mapping.cfSpace || 'app';
    }

    function targetKey(org, space) {
      return JSON.stringify([org, space || 'app']);
    }

    function selectedTargetKey() {
      if (!state.selectedOrg || !state.selectedSpace) return null;
      return targetKey(state.selectedOrg, state.selectedSpace);
    }

    function selectedOrgSpaces() {
      return state.selectedOrg ? (state.spacesByOrg[state.selectedOrg] || []) : [];
    }

    function restoreFolderForSelectedTarget() {
      const key = selectedTargetKey();
      state.selectedFolder = key ? (state.foldersByTarget[key] || null) : null;
    }

    function buildLiveStatus() {
      if (state.error) return 'Error: ' + state.error;
      if (state.screen === SCREENS.LOGGING_IN) return 'Logging in to Cloud Foundry...';
      if (state.screen === SCREENS.LOADING_SPACES && state.selectedOrg) {
        return 'Loading spaces for ' + state.selectedOrg + '...';
      }
      if (state.screen === SCREENS.LOADING_APPS && state.selectedOrg) {
        const target = state.selectedSpace ? state.selectedOrg + ' / ' + state.selectedSpace : state.selectedOrg;
        return 'Loading apps for ' + target + '...';
      }
      const activeCount = Object.keys(state.activeSessions).length;
      if (activeCount > 0) {
        return activeCount + ' debug session' + (activeCount === 1 ? '' : 's') + ' active.';
      }
      return '';
    }

    function hasSnapshot(snapshotId) {
      return state.breakpointSnapshots.some(s => s.id === snapshotId);
    }

    function syncSelectedSnapshot() {
      if (state.breakpointSnapshots.length === 0) {
        state.selectedBreakpointSnapshotId = null;
        return;
      }
      if (!state.selectedBreakpointSnapshotId || !hasSnapshot(state.selectedBreakpointSnapshotId)) {
        state.selectedBreakpointSnapshotId = state.breakpointSnapshots[0].id;
      }
    }

    function setBreakpointSnapshots(snapshots) {
      state.breakpointSnapshots = Array.isArray(snapshots) ? snapshots.slice(0, 300) : [];
      syncSelectedSnapshot();
    }

    // === ORG SEARCH HELPERS ===

    /**
     * Re-renders only the org-search results block when the user types into the
     * search input. A full render() would rebuild the whole region grid and
     * destroy the input element (taking focus with it).
     */
    function selectedTopologyOrgStillExists() {
      return !!findSelectedTopologyAccount();
    }

    function syncSelectedTopologyOrgWithFilter() {
      if (!state.selectedTopologyOrg) return;
      const filtered = filterTopologyAccounts(
        (state.cfTopology && state.cfTopology.accounts) || [],
        state.orgSearchQuery,
      );
      const stillVisible = filtered.some(account =>
        account.regionKey === state.selectedTopologyOrg.regionKey
        && account.orgName === state.selectedTopologyOrg.orgName
      );
      if (!stillVisible) state.selectedTopologyOrg = null;
    }

    function refreshRegionFooterButton() {
      const loginBtn = document.getElementById('btn-login');
      if (!loginBtn) return;
      if (!hasReadyTopology() || state.regionSelectorMode === 'region') {
        loginBtn.textContent = 'Login to Cloud Foundry';
        loginBtn.removeAttribute('disabled');
        return;
      }
      if (selectedTopologyOrgStillExists()) {
        loginBtn.textContent = 'Continue with Selected Org';
        loginBtn.removeAttribute('disabled');
      } else {
        loginBtn.textContent = 'Select an Org to Continue';
        loginBtn.setAttribute('disabled', '');
      }
    }

    function refreshOrgSearchResults() {
      const block = document.querySelector('.org-search-block');
      if (!block) return;
      const accounts = (state.cfTopology && state.cfTopology.accounts) || [];
      const filtered = filterTopologyAccounts(accounts, state.orgSearchQuery);
      const resultsEl = block.querySelector('.org-search-results');
      if (!resultsEl) return;
      resultsEl.outerHTML = renderOrgSearchRows(filtered);
      refreshRegionFooterButton();
    }

    function refreshRegionResults() {
      const list = document.querySelector('.region-list');
      if (!list) return;
      list.innerHTML = renderRegionCards();
    }

    function beginRegionLogin() {
      const endpoint = state.useCustomEndpoint ? state.apiEndpoint : regionToEndpoint(state.selectedRegion);
      state.apiEndpoint = endpoint;
      state.error = null;
      state.selectedTopologyOrg = null;
      state.pendingTopologyOrg = null;
      state.screen = SCREENS.LOGGING_IN;
      render();
      vscode.postMessage({ type: 'LOGIN', payload: { apiEndpoint: endpoint } });
    }

    /**
     * Selecting a synced org only stages the choice. The footer button starts
     * login so users can review the selected org/region before continuing.
     */
    function stageTopologyOrg(regionKey, orgName) {
      const account = findTopologyAccount(regionKey, orgName);
      if (!account) return;
      state.error = null;
      state.useCustomEndpoint = false;
      state.selectedRegion = regionKey;
      state.apiEndpoint = account.apiEndpoint;
      state.selectedOrg = orgName;
      state.selectedSpace = null;
      state.selectedTopologyOrg = { regionKey, orgName };
      render();
    }

    function continueWithSelectedTopologyOrg() {
      const account = findSelectedTopologyAccount();
      if (!account) {
        state.error = 'Select an org before continuing.';
        render();
        return;
      }
      state.error = null;
      state.useCustomEndpoint = false;
      state.selectedRegion = account.regionKey;
      state.apiEndpoint = account.apiEndpoint;
      state.selectedOrg = account.orgName;
      state.selectedSpace = null;
      state.pendingTopologyOrg = { regionKey: account.regionKey, orgName: account.orgName };
      state.screen = SCREENS.LOGGING_IN;
      render();
      vscode.postMessage({ type: 'LOGIN', payload: { apiEndpoint: account.apiEndpoint } });
    }

    function addBreakpointSnapshot(snapshot) {
      state.breakpointSnapshots = [snapshot, ...state.breakpointSnapshots].slice(0, 300);
      syncSelectedSnapshot();
    }

    // === RENDERERS (injected) ===

    ${getRendererScriptContent()}
    ${getPackageBrowserScriptContent()}

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
        case SCREENS.LOADING_SPACES:      return renderLoadingSpaces();
        case SCREENS.SELECT_SPACE:        return renderSelectSpace();
        case SCREENS.SELECT_FOLDER:       return renderSelectFolder();
        case SCREENS.LOADING_APPS:        return renderLoadingApps();
        case SCREENS.READY:               return renderReady();
        case SCREENS.PACKAGES:            return renderPackagesScreen();
        case SCREENS.PACKAGE_SETTINGS:    return renderPackageSettingsScreen();
        case SCREENS.BREAKPOINT_SNAPSHOTS:return renderBreakpointSnapshotsScreen();
        case SCREENS.SETTINGS:            return renderSettings();
        case SCREENS.PREPARING_BRANCHES:  return renderPreparingBranches();
        default:                          return '';
      }
    }

    // === LISTENERS ===

    function attachListeners() {
      const $ = id => document.getElementById(id);

      document.querySelectorAll('[data-region-selector-mode]').forEach(el => {
        el.addEventListener('click', e => {
          const mode = e.currentTarget.dataset.regionSelectorMode;
          if (mode !== 'org' && mode !== 'region') return;
          state.regionSelectorMode = mode;
          state.error = null;
          render();
        });
      });

      const regionList = document.querySelector('.region-list');
      regionList?.addEventListener('change', e => {
        const input = e.target.closest('input[name="cf-region"]');
        if (!input) return;
        const value = input.value;
        state.selectedTopologyOrg = null;
        state.useCustomEndpoint = false;
        state.selectedRegion = value;
        state.apiEndpoint = regionToEndpoint(value);
        render();
      });

      $('api-endpoint-custom')?.addEventListener('input', e => { state.apiEndpoint = e.target.value; });

      $('btn-custom-endpoint')?.addEventListener('click', () => {
        state.regionSelectorMode = 'region';
        state.useCustomEndpoint = true;
        state.selectedTopologyOrg = null;
        state.error = null;
        render();
      });

      $('btn-region-list')?.addEventListener('click', () => {
        state.useCustomEndpoint = false;
        state.error = null;
        state.apiEndpoint = regionToEndpoint(state.selectedRegion);
        render();
      });

      $('btn-login')?.addEventListener('click', () => {
        if (hasReadyTopology() && state.regionSelectorMode !== 'region') {
          continueWithSelectedTopologyOrg();
          return;
        }
        beginRegionLogin();
      });

      // Cross-region org search (only present when cf-sync has data).
      const orgSearchInput = $('org-search-input');
      if (orgSearchInput) {
        orgSearchInput.addEventListener('input', e => {
          state.orgSearchQuery = e.target.value;
          syncSelectedTopologyOrgWithFilter();
          // Lightweight refresh that does not rebuild the whole region grid —
          // avoids losing focus on the search input while typing.
          refreshOrgSearchResults();
        });
        orgSearchInput.addEventListener('keydown', e => {
          if (e.key !== 'Enter') return;
          const accounts = filterTopologyAccounts(
            (state.cfTopology && state.cfTopology.accounts) || [],
            state.orgSearchQuery,
          );
          if (accounts.length === 0) return;
          e.preventDefault();
          // Enter activates the first match. Most full org-name searches narrow
          // down to a single hit, so this saves a click.
          const first = accounts[0];
          stageTopologyOrg(first.regionKey, first.orgName);
        });
      }
      const orgSearchBlock = document.querySelector('.org-search-block');
      if (orgSearchBlock) {
        orgSearchBlock.addEventListener('click', e => {
          const row = e.target.closest('[data-org-search-region][data-org-search-org]');
          if (!row) return;
          stageTopologyOrg(row.dataset.orgSearchRegion, row.dataset.orgSearchOrg);
        });
      }

      $('region-search-input')?.addEventListener('input', e => {
        state.regionSearchQuery = e.target.value;
        refreshRegionResults();
      });

      document.querySelectorAll('input[name="cf-org"]').forEach(el => {
        el.addEventListener('change', e => {
          state.selectedOrg = e.target.value;
          state.selectedSpace = null;
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
        if (!state.selectedOrg) return;
        state.error = null;
        state.screen = SCREENS.LOADING_SPACES;
        render();
        vscode.postMessage({ type: 'LOAD_SPACES', payload: { org: state.selectedOrg } });
      });

      document.querySelectorAll('input[name="cf-space"]').forEach(el => {
        el.addEventListener('change', e => {
          state.selectedSpace = e.target.value;
          document.querySelectorAll('label.space-item').forEach(label => {
            const inp = label.querySelector('input[name="cf-space"]');
            if (inp) label.classList.toggle('selected', inp.value === state.selectedSpace);
          });
          const nextBtn = document.getElementById('btn-next-space');
          if (nextBtn) nextBtn.removeAttribute('disabled');
        });
      });

      $('btn-next-space')?.addEventListener('click', () => {
        if (!state.selectedOrg || !state.selectedSpace) return;
        state.error = null;
        restoreFolderForSelectedTarget();
        state.screen = SCREENS.SELECT_FOLDER;
        render();
      });

      $('btn-back-space-org')?.addEventListener('click', () => {
        state.screen = SCREENS.SELECT_ORG;
        state.error = null;
        render();
      });

      $('btn-browse-folder')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'SELECT_GROUP_FOLDER' });
      });

      $('btn-save-mapping')?.addEventListener('click', () => {
        if (!state.selectedOrg || !state.selectedSpace || !state.selectedFolder) return;
        const key = selectedTargetKey();
        if (key) state.foldersByTarget[key] = state.selectedFolder;
        const mapping = {
          cfOrg: state.selectedOrg,
          cfSpace: state.selectedSpace,
          groupFolderPath: state.selectedFolder,
          lastUsedAt: Date.now()
        };
        const mappings = [mapping];
        state.mappings = upsertWebviewOrgMapping(state.mappings, mapping);
        state.error = null;
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({ type: 'SAVE_MAPPINGS', payload: { mappings } });
        vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg, space: state.selectedSpace } });
      });

      $('btn-back-region')?.addEventListener('click', () => {
        state.screen = SCREENS.REGION; state.error = null; render();
      });

      $('btn-back-select-org')?.addEventListener('click', () => {
        state.screen = selectedOrgSpaces().length > 1 ? SCREENS.SELECT_SPACE : SCREENS.SELECT_ORG;
        state.error = null;
        render();
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
          const packagesBtn = e.target.closest('[data-packages-app]');
          if (packagesBtn) {
            openPackagesScreen(packagesBtn.dataset.packagesApp);
            return;
          }
        });
      }

      const breakpointPanel = document.getElementById('breakpoint-snapshots-panel');
      if (breakpointPanel) {
        breakpointPanel.addEventListener('click', e => {
          const clearBtn = e.target.closest('#btn-clear-breakpoint-snapshots');
          if (clearBtn) {
            vscode.postMessage({ type: 'CLEAR_BREAKPOINT_SNAPSHOTS' });
            return;
          }
          const snapshotBtn = e.target.closest('[data-breakpoint-snapshot-id]');
          if (snapshotBtn) {
            state.selectedBreakpointSnapshotId = snapshotBtn.dataset.breakpointSnapshotId;
            refreshBreakpointSnapshotsPanel();
          }
        });
      }

      $('btn-refresh-apps')?.addEventListener('click', () => {
        if (!state.selectedOrg || !state.selectedSpace) return;
        state.error = null;
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({
          type: 'LOAD_APPS',
          payload: { org: state.selectedOrg, space: state.selectedSpace, forceRefresh: true }
        });
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
        vscode.postMessage({ type: 'START_DEBUG', payload: { appNames, org: state.selectedOrg, space: state.selectedSpace } });
      });

      $('btn-remap')?.addEventListener('click', () => {
        if (Object.keys(state.activeSessions).length > 0) {
          vscode.postMessage({ type: 'REQUEST_CHANGE_MAPPING' });
        } else {
          state.screen = SCREENS.REGION;
          state.error = null;
          state.selectedOrg = null;
          state.selectedSpace = null;
          state.selectedFolder = null;
          state.selectedTopologyOrg = null;
          state.pendingTopologyOrg = null;
          state.orgSearchQuery = '';
          state.regionSearchQuery = '';
          render();
        }
      });

      $('btn-retry-apps')?.addEventListener('click', () => {
        if (!state.selectedOrg || !state.selectedSpace) return;
        state.error = null;
        state.screen = SCREENS.LOADING_APPS;
        render();
        vscode.postMessage({
          type: 'LOAD_APPS',
          payload: { org: state.selectedOrg, space: state.selectedSpace, forceRefresh: true }
        });
      });

      $('btn-cancel-login')?.addEventListener('click', () => {
        state.screen = SCREENS.REGION;
        state.error = null;
        state.selectedTopologyOrg = null;
        state.pendingTopologyOrg = null;
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
      // Packages screen listeners (defined in packageBrowserContent.ts content)
      attachPackageListeners();
      attachPackageSettingsListeners();
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
          state.screen = SCREENS.REGION;
          state.error = null;
          state.selectedOrg = null;
          state.selectedSpace = null;
          state.selectedFolder = null;
          state.selectedTopologyOrg = null;
          state.pendingTopologyOrg = null;
          state.orgSearchQuery = '';
          state.regionSearchQuery = '';
          render();
          return;
        case 'LOGIN_SUCCESS': {
          state.orgs = msg.payload.orgs;
          state.spacesByOrg = {};
          state.selectedSpace = null;
          state.isReconnecting = false;
          state.error = null;
          // Topology shortcut: when the user picked an org from the cross-region
          // search, the live org list should still contain it. Skip Step 2/3 by
          // requesting spaces immediately. If the org has been removed since the
          // last sync, fall back to the standard SELECT_ORG flow with an inline
          // error so the user understands why their pick was discarded.
          if (state.pendingTopologyOrg) {
            const expectedOrg = state.pendingTopologyOrg.orgName;
            state.pendingTopologyOrg = null;
            if (Array.isArray(state.orgs) && state.orgs.indexOf(expectedOrg) !== -1) {
              state.selectedOrg = expectedOrg;
              state.screen = SCREENS.LOADING_SPACES;
              render();
              vscode.postMessage({ type: 'LOAD_SPACES', payload: { org: expectedOrg } });
              return;
            }
            state.error = 'Org "' + expectedOrg + '" is no longer available in this region. Please refresh cf-sync or pick a different org.';
            state.screen = SCREENS.SELECT_ORG;
            break;
          }
          state.screen = SCREENS.SELECT_ORG;
          break;
        }
        case 'LOGIN_ERROR':
          state.isReconnecting = false;
          state.error = msg.payload.message;
          state.selectedTopologyOrg = null;
          state.pendingTopologyOrg = null;
          state.screen = SCREENS.REGION;
          break;
        case 'SPACES_LOADED': {
          if (msg.payload.org !== state.selectedOrg || state.screen !== SCREENS.LOADING_SPACES) return;
          const spaces = Array.isArray(msg.payload.spaces) ? msg.payload.spaces : [];
          state.spacesByOrg[msg.payload.org] = spaces;
          if (spaces.length === 1) {
            state.selectedSpace = spaces[0];
            restoreFolderForSelectedTarget();
            state.screen = SCREENS.SELECT_FOLDER;
          } else {
            if (!spaces.includes(state.selectedSpace)) state.selectedSpace = null;
            state.screen = SCREENS.SELECT_SPACE;
          }
          state.error = null;
          break;
        }
        case 'SPACES_ERROR':
          if (msg.payload.org !== state.selectedOrg || state.screen !== SCREENS.LOADING_SPACES) return;
          state.error = msg.payload.message;
          state.screen = SCREENS.SELECT_ORG;
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
          let needFullRender = false;
          // If a DEBUG_CONNECTING message was dropped while branch preparation was active,
          // APP_DEBUG_STATUS can still arrive from processManager. Recover by returning to
          // READY so launcher controls (including Breakpoint Snapshots navigation) remain visible.
          if (
            state.screen === SCREENS.PREPARING_BRANCHES
            && (status === 'TUNNELING' || status === 'ATTACHED' || status === 'ERROR' || status === 'EXITED')
          ) {
            state.screen = SCREENS.READY;
            state.branchPrepServices = [];
            needFullRender = true;
          }
          if (status === 'EXITED') {
            const session = state.activeSessions[appName];
            if (session?.intervalId) clearInterval(session.intervalId);
            delete state.activeSessions[appName];
            if (needFullRender) {
              render();
            } else {
              refreshActiveSessionsPanel();
              refreshAppListSection();
            }
            syncPackageBrowserAppSelection();
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

          if (needFullRender) {
            render();
          } else {
            refreshActiveSessionsPanel();
            refreshAppListSection();
          }
          syncPackageBrowserAppSelection();
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
        case 'CF_TOPOLOGY': {
          const incoming = msg.payload && Array.isArray(msg.payload.accounts)
            ? msg.payload
            : { ready: false, accounts: [] };
          state.cfTopology = incoming;
          if (!selectedTopologyOrgStillExists()) {
            state.selectedTopologyOrg = null;
          }
          // Only re-render when the REGION step is visible AND the search-block's
          // visibility itself toggles (ready ↔ not-ready). Pure result-set changes
          // (more orgs synced) get a partial refresh that preserves the input
          // focus + caret position so users typing during a sync don't lose work.
          if (state.screen === SCREENS.REGION) {
            const hasSearchBlock = !!document.querySelector('.region-selector-tabs');
            const shouldHaveBlock = !!incoming.ready && incoming.accounts.length > 0;
            if (hasSearchBlock !== shouldHaveBlock) {
              render();
            } else if (shouldHaveBlock && state.regionSelectorMode !== 'region') {
              refreshOrgSearchResults();
            } else {
              refreshRegionFooterButton();
            }
          }
          return;
        }
        case 'CACHE_CONFIG':
          state.cacheConfig = msg.payload;
          if (state.screen === SCREENS.SETTINGS) render();
          return;
        case 'DEBUG_PREFS':
          state.debugPrefs = msg.payload;
          if (state.screen === SCREENS.READY) {
            render();
            return;
          }
          // Always sync both panels so active-session cards and the app-list
          // (which grays-out apps currently being debugged) stay consistent
          // whenever prefs are pushed from the extension.
          refreshActiveSessionsPanel();
          refreshAppListSection();
          // Do NOT call render() here — the Settings UI updates its checkbox in-place
          // and render() would rebuild the full DOM, accumulating duplicate listeners
          // on every subsequent toggle.
          return;
        case 'DEBUG_SESSION_PACKAGE_PREFS':
          state.debugSessionPackagePrefs = msg.payload;
          state.packageSettingsDraftRegex = msg.payload.packageNameFilterRegex;
          state.packageSettingsError = null;
          if (state.screen === SCREENS.PACKAGES) {
            if (getPackageSearchQuery() && !state.packageBrowserLoading && state.packageBaseEntries.length > 0) {
              requestPackageSearch(state.packageBrowserAppName, state.packageBrowserSearchQuery);
            } else {
              restorePackageEntriesFromBase();
            }
            refreshPackagesPanel();
            refreshPackagesSessionActions();
            return;
          }
          if (state.screen === SCREENS.PACKAGE_SETTINGS) {
            render();
            return;
          }
          return;
        case 'BREAKPOINT_SNAPSHOTS':
          setBreakpointSnapshots((msg.payload && msg.payload.snapshots) || []);
          if (state.screen === SCREENS.READY || state.screen === SCREENS.BREAKPOINT_SNAPSHOTS) {
            refreshBreakpointSnapshotsPanel();
          }
          if (state.screen === SCREENS.READY) {
            const snapshotLabel = state.breakpointSnapshots.length > 0
              ? 'Breakpoint Snapshots (' + state.breakpointSnapshots.length + ')'
              : 'Breakpoint Snapshots';
            const snapshotBtn = document.getElementById('btn-open-breakpoint-snapshots');
            if (snapshotBtn) snapshotBtn.textContent = snapshotLabel;
          }
          return;
        case 'BREAKPOINT_SNAPSHOT_ADDED':
          if (msg.payload && msg.payload.snapshot) {
            addBreakpointSnapshot(msg.payload.snapshot);
            if (state.screen === SCREENS.READY || state.screen === SCREENS.BREAKPOINT_SNAPSHOTS) {
              refreshBreakpointSnapshotsPanel();
            }
            if (state.screen === SCREENS.READY) {
              const snapshotLabel = 'Breakpoint Snapshots (' + state.breakpointSnapshots.length + ')';
              const snapshotBtn = document.getElementById('btn-open-breakpoint-snapshots');
              if (snapshotBtn) snapshotBtn.textContent = snapshotLabel;
            }
          }
          return;
        case 'PACKAGE_SOURCES_LOADED':
          if (msg.payload.appName !== state.packageBrowserAppName) return;
          state.packageBaseEntries = Array.isArray(msg.payload.packages) ? msg.payload.packages : [];
          state.packageEntries = state.packageBaseEntries.slice();
          state.packageBrowserLoading = false;
          state.packageSearchPending = false;
          state.packageBrowserError = null;
          if (getPackageSearchQuery() && state.packageBaseEntries.length > 0) {
            requestPackageSearch(state.packageBrowserAppName, state.packageBrowserSearchQuery);
          }
          if (state.screen === SCREENS.PACKAGES) {
            refreshPackagesSessionActions();
            refreshPackagesPanel();
          }
          return;
        case 'PACKAGE_SEARCH_RESULTS':
          if (msg.payload.appName !== state.packageBrowserAppName) return;
          if (msg.payload.requestId !== state.packageSearchRequestId) return;
          if (msg.payload.query.trim().toLowerCase() !== getPackageSearchQuery()) return;
          state.packageEntries = Array.isArray(msg.payload.packages) ? msg.payload.packages : [];
          state.packageSearchPending = false;
          state.packageBrowserError = null;
          if (state.screen === SCREENS.PACKAGES) {
            refreshPackagesPanel();
          }
          return;
        case 'PACKAGE_SOURCES_ERROR':
          if (msg.payload.appName !== state.packageBrowserAppName) return;
          state.packageBrowserLoading = false;
          state.packageSearchPending = false;
          state.packageBrowserError = msg.payload.message;
          if (state.screen === SCREENS.PACKAGES) {
            refreshPackagesSessionActions();
            refreshPackagesPanel();
          }
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
            // Rebuild the per-target folder cache from all persisted mappings so that
            // switching orgs/spaces auto-restores the correct folder.
            state.foldersByTarget = {};
            for (const m of cfg.orgGroupMappings) {
              state.foldersByTarget[targetKey(m.cfOrg, mappingSpace(m))] = m.groupFolderPath;
            }
          }

          // Gate: require credentials before proceeding with any other screen.
          if (!state.credentialStatus.hasCredentials) {
            state.screen = SCREENS.SETUP_CREDENTIALS;
            break;
          }

          if (cfg && state.mappings.length > 0) {
            const mapping = selectPreferredOrgMapping(state.orgs, state.mappings);
            if (mapping) {
              state.selectedOrg = mapping.cfOrg;
              state.selectedSpace = mappingSpace(mapping);
              state.selectedFolder = mapping.groupFolderPath;
              // Mark as restoring so APPS_ERROR can trigger auto-reconnect instead
              // of leaving the user stuck on a broken READY screen.
              state.isRestoringSession = true;
              state.screen = SCREENS.LOADING_APPS;
              render();
              vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg, space: state.selectedSpace } });
              return;
            }
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
              const mapping = selectPreferredOrgMapping(state.orgs, state.mappings);
              if (mapping) {
                state.selectedOrg = mapping.cfOrg;
                state.selectedSpace = mappingSpace(mapping);
                state.selectedFolder = mapping.groupFolderPath;
                state.isRestoringSession = true;
                state.screen = SCREENS.LOADING_APPS;
                render();
                vscode.postMessage({ type: 'LOAD_APPS', payload: { org: state.selectedOrg, space: state.selectedSpace } });
                return;
              }
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
    vscode.postMessage({ type: 'GET_DEBUG_SESSION_PACKAGE_PREFS' });
    vscode.postMessage({ type: 'LOAD_CONFIG' });
    render();
  </script>`;
}
