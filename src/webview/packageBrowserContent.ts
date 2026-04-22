export function getPackageBrowserScriptContent(): string {
  return `
    function getPackageBrowserAppNames() {
      return Object.keys(state.activeSessions)
        .filter(function(appName) { return state.activeSessions[appName].status === 'ATTACHED'; })
        .sort(function(left, right) { return left.localeCompare(right); });
    }

    function getPackageSearchQuery() {
      return (state.packageBrowserSearchQuery || '').trim().toLowerCase();
    }

    function getVisiblePackageEntries() {
      var query = getPackageSearchQuery();
      if (!query) return state.packageEntries.slice();
      return state.packageEntries.filter(function(entry) {
        if (entry.displayName.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)) {
          return true;
        }
        return entry.files.some(function(file) {
          return file.relativePath.toLowerCase().includes(query) || file.label.toLowerCase().includes(query);
        });
      });
    }

    function getVisibleFilesForPackage(entry) {
      var query = getPackageSearchQuery();
      if (!query) return entry.files;
      var matchesPackage = entry.displayName.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query);
      if (matchesPackage) return entry.files;
      return entry.files.filter(function(file) {
        return file.relativePath.toLowerCase().includes(query) || file.label.toLowerCase().includes(query);
      });
    }

    function getSelectedPackageEntry() {
      var visibleEntries = getVisiblePackageEntries();
      if (visibleEntries.length === 0) return null;
      for (var i = 0; i < visibleEntries.length; i++) {
        if (visibleEntries[i].id === state.selectedPackageId) return visibleEntries[i];
      }
      return visibleEntries[0];
    }

    function syncSelectedPackageEntry() {
      var selected = getSelectedPackageEntry();
      state.selectedPackageId = selected ? selected.id : null;
    }

    function findPackageFileById(fileId) {
      for (var i = 0; i < state.packageEntries.length; i++) {
        var files = state.packageEntries[i].files;
        for (var j = 0; j < files.length; j++) {
          if (files[j].id === fileId) return files[j];
        }
      }
      return null;
    }

    function beginPackageSourceLoad(appName, resetSearch) {
      if (!appName) return;
      state.packageBrowserAppName = appName;
      if (resetSearch) state.packageBrowserSearchQuery = '';
      state.packageBrowserLoading = true;
      state.packageBrowserError = null;
      state.packageEntries = [];
      state.selectedPackageId = null;
    }

    function requestPackageSources(appName, resetSearch) {
      if (!appName) return;
      beginPackageSourceLoad(appName, !!resetSearch);
      if (state.screen === SCREENS.PACKAGES) {
        refreshPackagesPanel();
      }
      vscode.postMessage({ type: 'LOAD_PACKAGE_SOURCES', payload: { appName: appName } });
    }

    function openPackagesScreen(appName) {
      beginPackageSourceLoad(appName, true);
      state.screen = SCREENS.PACKAGES;
      render();
      vscode.postMessage({ type: 'LOAD_PACKAGE_SOURCES', payload: { appName: appName } });
    }

    function syncPackageBrowserAppSelection() {
      if (state.screen !== SCREENS.PACKAGES) return;
      var appNames = getPackageBrowserAppNames();
      if (appNames.length === 0) {
        state.packageBrowserAppName = null;
        state.packageBrowserLoading = false;
        state.packageBrowserError = null;
        state.packageEntries = [];
        state.selectedPackageId = null;
        render();
        return;
      }
      if (state.packageBrowserAppName && appNames.indexOf(state.packageBrowserAppName) !== -1) {
        render();
        return;
      }
      var nextAppName = appNames[0];
      if (!nextAppName) return;
      beginPackageSourceLoad(nextAppName, false);
      render();
      vscode.postMessage({ type: 'LOAD_PACKAGE_SOURCES', payload: { appName: nextAppName } });
    }

    function renderPackagesPanelContent() {
      var appNames = getPackageBrowserAppNames();
      if (appNames.length === 0) {
        return '<div class="packages-empty">No attached debug sessions are available.</div>';
      }

      syncSelectedPackageEntry();
      var selectedPackage = getSelectedPackageEntry();
      var visiblePackages = getVisiblePackageEntries();
      var query = getPackageSearchQuery();
      var errorBox = state.packageBrowserError
        ? '<div class="error-box packages-error">' + escape(state.packageBrowserError) + '</div>'
        : '';

      if (state.packageBrowserLoading) {
        return errorBox + '<div class="packages-loading"><span class="spinner"></span><span>Loading packages for '
          + escape(state.packageBrowserAppName || '') + '...</span></div>';
      }

      if (state.packageEntries.length === 0) {
        return errorBox + '<div class="packages-empty">No loaded package sources found for this debug session.</div>';
      }

      if (visiblePackages.length === 0) {
        return errorBox + '<div class="packages-empty">No packages match the current filter.</div>';
      }

      var packageListHtml = visiblePackages.map(function(entry) {
        var selectedClass = entry.id === state.selectedPackageId ? ' selected' : '';
        return '<button class="packages-package-item' + selectedClass + '" data-package-entry-id="' + escape(entry.id)
          + '" aria-label="Open package ' + escape(entry.displayName) + '">'
          + '<span class="packages-package-name">' + escape(entry.displayName) + '</span>'
          + '<span class="packages-package-count">' + entry.files.length + '</span>'
          + '</button>';
      }).join('');

      var files = selectedPackage ? getVisibleFilesForPackage(selectedPackage) : [];
      var filesHtml = files.length > 0
        ? files.map(function(file) {
          return '<button class="packages-file-item" data-package-file-id="' + escape(file.id)
            + '" aria-label="Open package file ' + escape(file.relativePath) + '">'
            + '<span class="packages-file-path">' + escape(file.relativePath) + '</span>'
            + '</button>';
        }).join('')
        : '<div class="packages-empty packages-files-empty">'
          + (query ? 'No files in this package match the current filter.' : 'Select a package to inspect its files.')
          + '</div>';

      return errorBox
        + '<div class="packages-summary">'
        + '<span>' + visiblePackages.length + ' package' + (visiblePackages.length === 1 ? '' : 's') + '</span>'
        + '<span>' + escape(state.packageBrowserAppName || '') + '</span>'
        + '</div>'
        + '<div class="packages-columns">'
        + '<div class="packages-section">'
        + '<div class="section-label packages-section-label">Packages</div>'
        + '<div class="packages-list">' + packageListHtml + '</div>'
        + '</div>'
        + '<div class="packages-section">'
        + '<div class="section-label packages-section-label">Files</div>'
        + '<div class="packages-files">' + filesHtml + '</div>'
        + '</div>'
        + '</div>';
    }

    function renderPackagesScreen() {
      var appNames = getPackageBrowserAppNames();
      var options = appNames.map(function(appName) {
        var selected = appName === state.packageBrowserAppName ? ' selected' : '';
        return '<option value="' + escape(appName) + '"' + selected + '>' + escape(appName) + '</option>';
      }).join('');

      return \`
        <div class="ready-layout">
          <div class="step-header">
            <span class="step-title">Packages</span>
            <button class="gear-btn" id="btn-refresh-packages" title="Refresh packages" aria-label="Refresh packages">&#8635;</button>
          </div>
          <div class="info-box">Browse loaded package sources for the current debug session and filter them before opening files.</div>
          <div class="section-label">Debug Session</div>
          <select class="select" id="packages-app-select" aria-label="Select debug session" \${appNames.length === 0 ? 'disabled' : ''}>
            \${options || '<option value="">No attached sessions</option>'}
          </select>
          <div style="height:8px"></div>
          <input class="input" id="packages-search-input" placeholder="Filter packages or files&hellip;"
            aria-label="Filter packages or files" value="\${escape(state.packageBrowserSearchQuery)}" />
          <div style="height:10px"></div>
          <div id="packages-panel" class="packages-panel">\${renderPackagesPanelContent()}</div>
          <div class="footer" style="padding-top:0">
            <button class="btn btn-secondary" id="btn-back-packages">&#8592; Back to Launcher</button>
          </div>
        </div>
      \`;
    }

    function refreshPackagesPanel() {
      var panel = document.getElementById('packages-panel');
      if (!panel) return;
      panel.innerHTML = renderPackagesPanelContent();
    }

    function attachPackageListeners() {
      var appSelect = document.getElementById('packages-app-select');
      if (appSelect) {
        appSelect.addEventListener('change', function(e) {
          requestPackageSources(e.target.value, false);
        });
      }

      var searchInput = document.getElementById('packages-search-input');
      if (searchInput) {
        searchInput.addEventListener('input', function(e) {
          state.packageBrowserSearchQuery = e.target.value;
          syncSelectedPackageEntry();
          refreshPackagesPanel();
        });
      }

      document.getElementById('btn-refresh-packages')?.addEventListener('click', function() {
        requestPackageSources(state.packageBrowserAppName, false);
      });

      document.getElementById('btn-back-packages')?.addEventListener('click', function() {
        state.screen = SCREENS.READY;
        render();
      });

      var panel = document.getElementById('packages-panel');
      if (!panel) return;
      panel.addEventListener('click', function(e) {
        var packageBtn = e.target.closest('[data-package-entry-id]');
        if (packageBtn) {
          state.selectedPackageId = packageBtn.dataset.packageEntryId;
          refreshPackagesPanel();
          return;
        }

        var fileBtn = e.target.closest('[data-package-file-id]');
        if (!fileBtn || !state.packageBrowserAppName) return;
        var file = findPackageFileById(fileBtn.dataset.packageFileId);
        if (!file) return;
        vscode.postMessage({
          type: 'OPEN_PACKAGE_SOURCE',
          payload: {
            appName: state.packageBrowserAppName,
            source: file.source,
          },
        });
      });
    }
  `;
}
