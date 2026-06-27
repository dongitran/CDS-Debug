/**
 * Utility functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getUtilsScriptContent(): string {
  return `
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

    function normalizeTopologySpace(space) {
      if (typeof space === 'string') return { name: space, apps: [] };
      if (!space || typeof space !== 'object' || typeof space.name !== 'string') return null;
      return {
        name: space.name,
        apps: Array.isArray(space.apps) ? space.apps : [],
        error: typeof space.error === 'string' ? space.error : undefined,
      };
    }

    function findTopologyAccountForNavigation(regionKey, orgName) {
      if (!state.cfTopology || !state.cfTopology.ready || !Array.isArray(state.cfTopology.accounts)) return null;
      const resolvedKey = regionKey || endpointToRegion(state.apiEndpoint);
      const endpoint = normalizeEndpointValue(state.apiEndpoint);
      return state.cfTopology.accounts.find(account => {
        if (account.orgName !== orgName) return false;
        if (resolvedKey && account.regionKey === resolvedKey) return true;
        return endpoint && normalizeEndpointValue(account.apiEndpoint) === endpoint;
      }) || null;
    }

    function getSpacesFromTopology(regionKey, orgName) {
      const account = findTopologyAccountForNavigation(regionKey, orgName);
      if (!account || !Array.isArray(account.spaces) || account.spaces.length === 0) return null;
      return account.spaces.map(normalizeTopologySpace).filter(Boolean);
    }

    function getAppsFromTopology(regionKey, orgName, spaceName) {
      const spaces = getSpacesFromTopology(regionKey, orgName);
      if (!spaces) return null;
      const space = spaces.find(candidate => candidate.name === spaceName);
      if (!space || space.error) return null;
      return space.apps;
    }

    function hasAppsChanged(currentApps, nextApps) {
      return JSON.stringify(currentApps || []) !== JSON.stringify(nextApps || []);
    }

    function pruneSelectedAppsTo(apps) {
      const validNames = new Set(apps.map(app => app.name));
      state.selectedApps = new Set([...state.selectedApps].filter(name => validNames.has(name)));
    }

    function findAppByName(appName) {
      return state.apps.find(app => app.name === appName) || null;
    }

    function hasInstanceCounts(app) {
      return !!app && typeof app.runningInstances === 'number' && typeof app.totalInstances === 'number';
    }

    function getScaleDisabledReason(app) {
      if (!app) return 'App is no longer available';
      if (state.activeSessions[app.name]) return 'Stop debugging this app before scaling instances';
      if (state.scalePendingAppName === app.name) return 'Scaling is already in progress';
      if (!hasInstanceCounts(app)) return 'Current instance counts are unavailable';
      if (app.state !== 'started') return 'Only started apps can be scaled';
      if (app.instanceProcessCount !== undefined && app.instanceProcessCount > 1) {
        return 'Scaling multiple CF processes is not supported from this badge yet';
      }
      if (app.runningInstances !== app.totalInstances) return 'Wait until current instances are running before scaling';
      if (app.totalInstances < 1) return 'Scale from at least one running instance';
      return '';
    }

    function canScaleAppInstances(app) {
      return getScaleDisabledReason(app) === '';
    }

    function getScaleDraftBounds(app) {
      const current = hasInstanceCounts(app) ? app.totalInstances : 1;
      return {
        min: Math.max(1, current - 1),
        max: current + 1,
      };
    }

    function clampScaleDraft(app, value) {
      const bounds = getScaleDraftBounds(app);
      return Math.min(bounds.max, Math.max(bounds.min, value));
    }

    function getScaleDraftInstances(app) {
      const popover = state.instanceScalePopover;
      if (!popover || !app || popover.appName !== app.name) return hasInstanceCounts(app) ? app.totalInstances : 1;
      return clampScaleDraft(app, popover.draftInstances);
    }

    function openInstanceScalePopover(appName) {
      const app = findAppByName(appName);
      if (!canScaleAppInstances(app)) return;
      state.instanceScalePopover = {
        appName,
        draftInstances: app.totalInstances,
      };
      refreshAppListSection();
    }

    function adjustInstanceScaleDraft(appName, delta) {
      const app = findAppByName(appName);
      if (!canScaleAppInstances(app)) return;
      const currentDraft = getScaleDraftInstances(app);
      state.instanceScalePopover = {
        appName,
        draftInstances: clampScaleDraft(app, currentDraft + delta),
      };
      refreshAppListSection();
    }

    function cancelInstanceScalePopover() {
      state.instanceScalePopover = null;
      refreshAppListSection();
    }

    function applyInstanceScale(appName) {
      const app = findAppByName(appName);
      if (!state.selectedOrg || !state.selectedSpace || !canScaleAppInstances(app)) return;
      const targetInstances = getScaleDraftInstances(app);
      if (targetInstances === app.totalInstances) return;
      state.scalePendingAppName = appName;
      state.instanceScalePopover = null;
      refreshAppListSection();
      vscode.postMessage({
        type: 'SCALE_APP_INSTANCES',
        payload: {
          appName,
          org: state.selectedOrg,
          space: state.selectedSpace,
          targetInstances,
        },
      });
    }

    function enterReadyWithTopologyApps(org, space, apps) {
      state.apps = apps;
      state.selectedApps = new Set();
      state.instanceScalePopover = null;
      state.scalePendingAppName = null;
      state.isRestoringSession = false;
      state.screen = SCREENS.READY;
      state.error = null;
      render();
      vscode.postMessage({ type: 'WARMUP_CF_SESSION', payload: { org, space } });
    }

    function loadAppsViaTopologyFirst(org, space, opts) {
      const apps = getAppsFromTopology(state.selectedRegion, org, space);
      // An empty array means cf-sync knows the space but has not synced its apps yet
      // (or stored spaces in the legacy string format). Serving it would land the user
      // on a READY screen with zero app rows and never trigger the live fetch — the
      // "launcher looks completely empty" report. Treat it as no data.
      if (apps && apps.length > 0) {
        enterReadyWithTopologyApps(org, space, apps);
        return true;
      }
      state.screen = SCREENS.LOADING_APPS;
      render();
      vscode.postMessage({ type: 'LOAD_APPS', payload: { org, space, ...(opts || {}) } });
      return false;
    }

    function loadSpacesViaTopologyFirst(org) {
      const spaces = getSpacesFromTopology(state.selectedRegion, org);
      if (!spaces) {
        state.screen = SCREENS.LOADING_SPACES;
        render();
        vscode.postMessage({ type: 'LOAD_SPACES', payload: { org } });
        return false;
      }

      const spaceNames = spaces.map(space => space.name);
      state.spacesByOrg[org] = spaceNames;
      if (spaceNames.length === 1) {
        state.selectedSpace = spaceNames[0];
        restoreFolderForSelectedTarget();
        state.screen = SCREENS.SELECT_FOLDER;
      } else {
        if (!spaceNames.includes(state.selectedSpace)) state.selectedSpace = null;
        state.screen = SCREENS.SELECT_SPACE;
      }
      render();
      return true;
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
      vscode.postMessage({
        type: 'LOGIN',
        payload: { apiEndpoint: account.apiEndpoint, topologyOrgName: account.orgName },
      });
    }

    function addBreakpointSnapshot(snapshot) {
      state.breakpointSnapshots = [snapshot, ...state.breakpointSnapshots].slice(0, 300);
      syncSelectedSnapshot();
    }
`;
}
