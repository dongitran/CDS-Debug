/**
 * DOM event listeners for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getListenersScriptContent(): string {
  return `
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
        state.suppressConfigAutoRestore = true;
        state.selectedTopologyOrg = null;
        state.useCustomEndpoint = false;
        state.selectedRegion = value;
        state.apiEndpoint = regionToEndpoint(value);
        render();
      });

      $('api-endpoint-custom')?.addEventListener('input', e => { state.apiEndpoint = e.target.value; });

      $('btn-custom-endpoint')?.addEventListener('click', () => {
        state.suppressConfigAutoRestore = true;
        state.regionSelectorMode = 'region';
        state.useCustomEndpoint = true;
        state.selectedTopologyOrg = null;
        state.error = null;
        render();
      });

      $('btn-region-list')?.addEventListener('click', () => {
        state.suppressConfigAutoRestore = true;
        state.useCustomEndpoint = false;
        state.error = null;
        state.apiEndpoint = regionToEndpoint(state.selectedRegion);
        render();
      });

      $('btn-login')?.addEventListener('click', () => {
        state.suppressConfigAutoRestore = true;
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
        state.suppressConfigAutoRestore = true;
        state.error = null;
        loadSpacesViaTopologyFirst(state.selectedOrg);
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
        state.suppressConfigAutoRestore = true;
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
        state.suppressConfigAutoRestore = true;
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
        vscode.postMessage({ type: 'SAVE_MAPPINGS', payload: { mappings } });
        loadAppsViaTopologyFirst(state.selectedOrg, state.selectedSpace);
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
          state.instanceScalePopover = null;
          refreshAppListSection();
        });
        appListEl.addEventListener('click', e => {
          const scaleBtn = e.target.closest('[data-scale-app]');
          if (scaleBtn) {
            e.preventDefault();
            const appName = scaleBtn.dataset.scaleApp;
            if (!appName) return;
            if (scaleBtn.hasAttribute('data-scale-step')) {
              adjustInstanceScaleDraft(appName, Number(scaleBtn.dataset.scaleStep));
              return;
            }
            if (scaleBtn.hasAttribute('data-scale-apply')) {
              applyInstanceScale(appName);
              return;
            }
            if (scaleBtn.hasAttribute('data-scale-cancel')) {
              cancelInstanceScalePopover();
              return;
            }
            openInstanceScalePopover(appName);
            return;
          }
          if (e.target.closest('.scale-popover')) return;
          if (e.target.closest('input[type="checkbox"][data-app]')) return;
          const row = e.target.closest('.app-row');
          if (!row) return;
          const cb = row.querySelector('input[type="checkbox"][data-app]');
          if (!cb || cb.disabled) return;
          cb.checked = !cb.checked;
          const name = cb.dataset.app;
          if (cb.checked) state.selectedApps.add(name);
          else state.selectedApps.delete(name);
          state.instanceScalePopover = null;
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
        state.suppressConfigAutoRestore = true;
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
          vscode.postMessage({ type: 'REQUEST_CHANGE_MAPPING' });
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
      // Recovery screen (unknown-screen fallback rendered by renderScreen's default case)
      attachRecoveryListener();
    }
`;
}
