/**
 * Extension message handler for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getMessageHandlerScriptContent(): string {
  return `
    window.addEventListener('message', event => {
      const msg = event.data;
      try {
        handleExtensionMessage(msg);
      } catch (err) {
        // A throw mid-handler would otherwise skip the final render() and freeze the
        // panel on a stale (possibly loading) screen with zero diagnostics.
        reportWebviewError('message:' + String(msg && msg.type), err);
        render();
      }
    });

    function handleExtensionMessage(msg) {
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
          if (typeof msg.payload.apiEndpoint === 'string' && msg.payload.apiEndpoint.length > 0) {
            state.apiEndpoint = msg.payload.apiEndpoint;
            const detectedRegion = endpointToRegion(msg.payload.apiEndpoint);
            if (detectedRegion && CF_REGIONS.some(r => r.code === detectedRegion)) {
              state.selectedRegion = detectedRegion;
              state.useCustomEndpoint = false;
            } else {
              state.useCustomEndpoint = true;
            }
          }
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
              loadSpacesViaTopologyFirst(expectedOrg);
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
          if (state.screen !== SCREENS.LOADING_APPS && !state.scalePendingAppName) return;
          state.apps = msg.payload.apps;
          state.selectedApps = new Set();
          state.instanceScalePopover = null;
          state.scalePendingAppName = null;
          state.isRestoringSession = false;
          state.screen = SCREENS.READY;
          state.error = null;
          break;
        case 'APPS_ERROR':
          if (state.screen !== SCREENS.LOADING_APPS) return;
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
        case 'DEBUG_DISCOVERING_REMOTE_ROOT': {
          // Surface the on-demand cf ssh probe on each app card so the user sees
          // why Start Debug is paused. Only upgrades the optimistic PENDING the
          // webview set on click — never overwrites TUNNELING/ATTACHED/ERROR.
          const names = (msg.payload && msg.payload.appNames) || [];
          for (let i = 0; i < names.length; i++) {
            const appName = names[i];
            const session = state.activeSessions[appName];
            if (!session || session.status === 'PENDING') {
              state.activeSessions[appName] = { status: 'DISCOVERING', msgPhase: 0 };
            }
          }
          refreshActiveSessionsPanel();
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
          // Clear any optimistically-added PENDING or DISCOVERING sessions — the
          // start request failed before any tunnel was established (e.g. cfTarget
          // network error or remote folder discovery aborted by the user).
          for (const appName of Object.keys(state.activeSessions)) {
            const status = state.activeSessions[appName].status;
            if (status === 'PENDING' || status === 'DISCOVERING') {
              delete state.activeSessions[appName];
            }
          }
          state.error = msg.payload.message;
          state.screen = SCREENS.READY;
          break;
        case 'APP_SCALE_ERROR':
          if (state.instanceScalePopover?.appName === msg.payload.appName) {
            state.instanceScalePopover = null;
          }
          if (state.scalePendingAppName === msg.payload.appName) {
            state.scalePendingAppName = null;
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
          if (state.screen === SCREENS.READY && state.selectedOrg && state.selectedSpace) {
            const updatedApps = getAppsFromTopology(state.selectedRegion, state.selectedOrg, state.selectedSpace);
            if (updatedApps && hasAppsChanged(state.apps, updatedApps)) {
              state.apps = updatedApps;
              pruneSelectedAppsTo(updatedApps);
              if (document.querySelector('.app-list')) {
                refreshActiveSessionsPanel();
                refreshAppListSection();
              } else {
                render();
              }
            }
          }
          return;
        }
        case 'CACHE_CONFIG':
          state.cacheConfig = msg.payload;
          if (state.screen === SCREENS.SETTINGS) render();
          return;
        case 'APP_WATCHDOG_CONFIG':
          state.appWatchdogConfig = msg.payload;
          if (state.screen === SCREENS.SETTINGS) render();
          return;
        case 'SSH_PROXY_STATUS':
          state.sshProxyStatus = msg.payload;
          if (state.screen === SCREENS.SETTINGS) render();
          return;
        case 'DEBUG_PREFS':
          state.debugPrefs = msg.payload;
          if (state.screen === SCREENS.SETTINGS) {
            syncDebugPreferenceControls();
            return;
          }
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
            if (state.suppressConfigAutoRestore) return;
            state.screen = SCREENS.SETUP_CREDENTIALS;
            break;
          }

          if (state.suppressConfigAutoRestore) return;

          if (cfg && state.mappings.length > 0) {
            const mapping = selectPreferredOrgMapping(state.orgs, state.mappings);
            if (mapping) {
              state.selectedOrg = mapping.cfOrg;
              state.selectedSpace = mappingSpace(mapping);
              state.selectedFolder = mapping.groupFolderPath;
              // Mark as restoring so APPS_ERROR can trigger auto-reconnect instead
              // of leaving the user stuck on a broken READY screen.
              state.isRestoringSession = true;
              loadAppsViaTopologyFirst(state.selectedOrg, state.selectedSpace);
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
                loadAppsViaTopologyFirst(state.selectedOrg, state.selectedSpace);
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

        case 'SCOPE_SYNCED': {
          const { orgName, spaceName } = msg.payload;
          if (state.selectedOrg === orgName && state.selectedSpace === spaceName) break;
          state.selectedOrg = orgName;
          state.selectedSpace = spaceName;
          restoreFolderForSelectedTarget();
          loadAppsViaTopologyFirst(orgName, spaceName);
          break;
        }
        case 'SCOPE_SYNCED_NO_MAPPING': {
          const { orgName, spaceName } = msg.payload;
          state.selectedOrg = orgName;
          state.selectedSpace = spaceName;
          state.suppressConfigAutoRestore = true;
          state.error = null;
          restoreFolderForSelectedTarget();
          state.screen = SCREENS.SELECT_FOLDER;
          break;
        }
        case 'REGION_PREFILL': {
          const { regionCode, apiEndpoint } = msg.payload;
          const isKnownRegion = CF_REGIONS.some(function(r) { return r.code === regionCode; });
          if (isKnownRegion) {
            state.selectedRegion = regionCode;
            state.useCustomEndpoint = false;
          } else {
            state.useCustomEndpoint = true;
          }
          state.apiEndpoint = apiEndpoint;
          break;
        }
      }
      render();
    }
`;
}
