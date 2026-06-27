/**
 * Client-side JavaScript framework for the CDS Debug Launcher webview.
 * Render functions live in webviewRenderers.ts and are injected at build time.
 * Runs in the VS Code webview browser context — no ES module imports allowed.
 * Sections: CONSTANTS → STATE → UTILS → RENDERERS → LISTENERS → MESSAGE HANDLER → INIT
 */
import { getRendererScriptContent } from './webviewRenderers';
import { getPackageBrowserScriptContent } from './packageBrowserContent';
import { getUtilsScriptContent } from './webviewUtilsScript';
import { getListenersScriptContent } from './webviewListenersScript';
import { getMessageHandlerScriptContent } from './webviewMessageHandlerScript';
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

// Keep only UI endpoints that cf-sync does not expose yet; the combined catalog
// remains de-duped so future upstream additions do not create duplicate radios.
const ADDITIONAL_WEBVIEW_CF_REGIONS = [
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
      instanceScalePopover: null,
      scalePendingAppName: null,
      error: null,
      activeSessions: {}, // { appName: { status, message, msgPhase, intervalId } }
      syncStatus: { isRunning: false, lastCompletedAt: null, currentRegion: null, currentOrg: null, done: 0, total: 0 },
      cacheConfig: { enabled: true, intervalHours: 24 },
      appWatchdogConfig: { enabled: true, pingIntervalSeconds: 90 },
      sshProxyStatus: {
        enabled: false,
        host: '',
        port: 22,
        username: '',
        hasPassword: false,
        connection: 'disabled',
      },
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
      suppressConfigAutoRestore: false,
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

    ${getUtilsScriptContent()}

    // === RENDERERS (injected) ===

    ${getRendererScriptContent()}
    ${getPackageBrowserScriptContent()}

    function reportWebviewError(context, err) {
      try {
        vscode.postMessage({
          type: 'WEBVIEW_ERROR',
          payload: {
            context: String(context),
            message: err && err.message ? String(err.message) : String(err),
            stack: err && err.stack ? String(err.stack).slice(0, 2000) : '',
            screen: String(state.screen || ''),
          },
        });
      } catch (postErr) {
        // postMessage itself failed — nothing else we can do from inside the webview.
      }
    }

    function renderRecoveryScreen(message) {
      return '<div class="step-header"><span class="step-title">CDS Debug</span></div>'
        + '<div class="error-box">The launcher hit an unexpected error and recovered. '
        + escape(message || 'Unknown error') + '</div>'
        + '<div style="height:10px"></div>'
        + '<button class="btn" id="btn-recover-reload">Reload Launcher</button>';
    }

    function attachRecoveryListener() {
      const btn = document.getElementById('btn-recover-reload');
      if (!btn) return;
      btn.addEventListener('click', () => {
        state.screen = SCREENS.REGION;
        state.error = null;
        state.suppressConfigAutoRestore = false;
        render();
        vscode.postMessage({ type: 'LOAD_CONFIG' });
      });
    }

    // Error boundary: a renderer exception must never leave the panel blank or frozen.
    // Without it, a throw on the FIRST render of a fresh webview context leaves the
    // initial empty <div id="app"> on screen forever with no diagnostics.
    function render() {
      const app = document.getElementById('app');
      try {
        app.innerHTML = renderScreen();
        attachListeners();
      } catch (err) {
        reportWebviewError('render', err);
        app.innerHTML = renderRecoveryScreen(err && err.message ? err.message : String(err));
        attachRecoveryListener();
      }
    }

    function updatePreferenceToggle(inputId, enabled, badgeText) {
      const input = document.getElementById(inputId);
      if (!input) return;
      input.checked = enabled;

      const toggle = input.closest('.toggle-switch');
      if (toggle) toggle.classList.toggle('on', enabled);

      if (!badgeText) return;
      const badge = input.closest('.pref-row')?.querySelector('.pref-state-badge');
      if (!badge) return;
      badge.textContent = badgeText;
      badge.classList.toggle('pref-state-on', enabled);
      badge.classList.toggle('pref-state-off', !enabled);
    }

    function syncDebugPreferenceControls() {
      updatePreferenceToggle(
        'chk-open-browser',
        !!state.debugPrefs.openBrowserOnAttach,
        state.debugPrefs.openBrowserOnAttach ? 'enabled' : 'off by default',
      );
      updatePreferenceToggle(
        'chk-breakpoint-snapshot-handling',
        !!state.debugPrefs.enableBreakpointSnapshotHandling,
        state.debugPrefs.enableBreakpointSnapshotHandling ? 'enabled' : 'off by default',
      );
      updatePreferenceToggle('chk-branch-prep', !!state.debugPrefs.enableBranchPrep, '');
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
        // An unknown screen value previously rendered '' — a permanently blank panel
        // with no way out. Surface it and offer a reset instead.
        default:                          return renderRecoveryScreen('Unknown screen "' + String(state.screen) + '"');
      }
    }

    // === LISTENERS ===

    ${getListenersScriptContent()}

    // === MESSAGE HANDLER ===

    ${getMessageHandlerScriptContent()}

    // === INIT ===

    // Forward uncaught webview errors to the extension's output channel — the panel
    // has no dev console in normal use, so without this an intermittent "blank
    // launcher" report is undiagnosable.
    window.addEventListener('error', event => {
      reportWebviewError('window.onerror', event.error || new Error(String(event.message)));
    });
    window.addEventListener('unhandledrejection', event => {
      reportWebviewError('unhandledrejection', event.reason || new Error('unhandled rejection'));
    });

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
