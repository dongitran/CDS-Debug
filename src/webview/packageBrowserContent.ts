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

    function resetPackageTreeState() {
      state.expandedPackageBranchIds = [];
      state.searchPackageBranchStates = {};
      state.selectedPackageFileId = null;
    }

    function getPackageEntryTree(entry) {
      return Array.isArray(entry.tree) ? entry.tree : [];
    }

    function getPackageRootBranchId(entry) {
      return 'package:' + entry.id;
    }

    function trimPackageDisplayLabel(label) {
      if (!label) return '';
      var nextAtIndex = label.indexOf('@', label.charAt(0) === '@' ? 1 : 0);
      if (nextAtIndex === -1) return label;
      return label.slice(0, nextAtIndex);
    }

    function getPackageTreeLabel(entry) {
      return trimPackageDisplayLabel(entry.displayName || entry.name || '');
    }

    function getFolderBranchId(entry, node) {
      return 'folder:' + entry.id + ':' + node.path;
    }

    function getFileTreeNodeId(file) {
      return 'file:' + file.id;
    }

    function uniqueValues(values) {
      var seen = Object.create(null);
      var result = [];
      for (var i = 0; i < values.length; i++) {
        var value = values[i];
        if (!value || seen[value]) continue;
        seen[value] = true;
        result.push(value);
      }
      return result;
    }

    function isExpandedPackageBranch(branchId) {
      return Array.isArray(state.expandedPackageBranchIds)
        && state.expandedPackageBranchIds.indexOf(branchId) !== -1;
    }

    function setExpandedPackageBranch(branchId, expanded) {
      var next = Array.isArray(state.expandedPackageBranchIds)
        ? state.expandedPackageBranchIds.slice()
        : [];
      var index = next.indexOf(branchId);
      if (expanded && index === -1) next.push(branchId);
      if (!expanded && index !== -1) next.splice(index, 1);
      state.expandedPackageBranchIds = next;
    }

    function getSearchPackageBranchStates() {
      return state.searchPackageBranchStates && typeof state.searchPackageBranchStates === 'object'
        ? state.searchPackageBranchStates
        : {};
    }

    function clearSearchPackageBranchStates() {
      state.searchPackageBranchStates = {};
    }

    function getSearchPackageBranchState(branchId) {
      var states = getSearchPackageBranchStates();
      if (!Object.prototype.hasOwnProperty.call(states, branchId)) return null;
      return states[branchId] === true;
    }

    function setSearchPackageBranchState(branchId, expanded) {
      var next = Object.assign({}, getSearchPackageBranchStates());
      next[branchId] = !!expanded;
      state.searchPackageBranchStates = next;
    }

    function setTreeBranchExpanded(branchId, expanded) {
      if (getPackageSearchQuery()) {
        setSearchPackageBranchState(branchId, expanded);
        return;
      }
      setExpandedPackageBranch(branchId, expanded);
    }

    function matchesPackageFile(node, query) {
      return node.name.toLowerCase().includes(query)
        || node.path.toLowerCase().includes(query)
        || node.file.relativePath.toLowerCase().includes(query);
    }

    function cloneVisibleFolderNode(node, children) {
      return {
        id: node.id,
        kind: node.kind,
        name: node.name,
        path: node.path,
        children: children,
      };
    }

    function filterPackageTreeNodes(entry, nodes, query) {
      var visibleNodes = [];
      var autoExpandedBranchIds = [];

      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node.kind === 'file') {
          if (matchesPackageFile(node, query)) visibleNodes.push(node);
          continue;
        }

        var folderMatches = node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query);
        var childResult = filterPackageTreeNodes(entry, node.children || [], query);
        if (!folderMatches && childResult.nodes.length === 0) continue;

        if (childResult.nodes.length > 0) {
          visibleNodes.push(cloneVisibleFolderNode(node, childResult.nodes));
          autoExpandedBranchIds.push(getFolderBranchId(entry, node));
        } else {
          visibleNodes.push(cloneVisibleFolderNode(node, node.children || []));
        }

        autoExpandedBranchIds = autoExpandedBranchIds.concat(childResult.autoExpandedBranchIds);
      }

      return {
        nodes: visibleNodes,
        autoExpandedBranchIds: uniqueValues(autoExpandedBranchIds),
      };
    }

    function getVisiblePackageViews() {
      var query = getPackageSearchQuery();
      return state.packageEntries
        .map(function(entry) {
          var packageMatches = !query
            || entry.displayName.toLowerCase().includes(query)
            || entry.name.toLowerCase().includes(query);
          if (!query) {
            return {
              entry: entry,
              nodes: getPackageEntryTree(entry),
              autoExpandedBranchIds: [],
            };
          }

          var filteredTree = filterPackageTreeNodes(entry, getPackageEntryTree(entry), query);
          if (!packageMatches && filteredTree.nodes.length === 0) return null;

          var autoExpandedBranchIds = filteredTree.autoExpandedBranchIds.slice();
          if (filteredTree.nodes.length > 0) {
            autoExpandedBranchIds.push(getPackageRootBranchId(entry));
          }
          return {
            entry: entry,
            nodes: filteredTree.nodes.length > 0 ? filteredTree.nodes : getPackageEntryTree(entry),
            autoExpandedBranchIds: uniqueValues(autoExpandedBranchIds),
          };
        })
        .filter(function(entryView) { return entryView !== null; });
    }

    function isTreeBranchExpanded(branchId, autoExpandedBranchIds) {
      if (getPackageSearchQuery()) {
        var searchOverride = getSearchPackageBranchState(branchId);
        if (searchOverride !== null) return searchOverride;
      }
      return autoExpandedBranchIds.indexOf(branchId) !== -1 || isExpandedPackageBranch(branchId);
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
      resetPackageTreeState();
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
        resetPackageTreeState();
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

    function findTreeRowById(panel, nodeId) {
      var rows = panel.querySelectorAll('[data-tree-node-id]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].dataset.treeNodeId === nodeId) return rows[i];
      }
      return null;
    }

    function getVisibleTreeRows(panel) {
      return Array.prototype.slice.call(panel.querySelectorAll('[data-tree-node-id]'));
    }

    function focusAdjacentTreeRow(panel, currentRow, delta) {
      var rows = getVisibleTreeRows(panel);
      var index = rows.indexOf(currentRow);
      if (index === -1) return;
      var next = rows[index + delta];
      if (next) focusTreeRow(next, false);
    }

    function focusBoundaryTreeRow(panel, index) {
      var rows = getVisibleTreeRows(panel);
      var next = rows[index];
      if (next) focusTreeRow(next, false);
    }

    function focusParentTreeRow(panel, currentRow) {
      var parentId = currentRow.dataset.treeParentBranchId;
      if (!parentId) return;
      var parentRow = findTreeRowById(panel, parentId);
      if (parentRow) focusTreeRow(parentRow, false);
    }

    function focusFirstChildTreeRow(panel, branchId) {
      var rows = getVisibleTreeRows(panel);
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].dataset.treeParentBranchId === branchId) {
          focusTreeRow(rows[i], false);
          return;
        }
      }
    }

    function focusTreeRow(row, preventScroll) {
      if (!row) return;
      if (preventScroll) {
        try {
          row.focus({ preventScroll: true });
          return;
        } catch {
        }
      }
      row.focus();
    }

    function getPackagesTreeScrollPosition(panel) {
      var tree = panel.querySelector('.packages-tree');
      if (!tree) return null;
      return {
        scrollLeft: tree.scrollLeft,
        scrollTop: tree.scrollTop,
      };
    }

    function restorePackagesTreeScrollPosition(panel, position) {
      if (!position) return;
      var tree = panel.querySelector('.packages-tree');
      if (!tree) return;
      tree.scrollLeft = position.scrollLeft;
      tree.scrollTop = position.scrollTop;
    }

    function refreshPackagesPanel(focusNodeId, preventScroll) {
      var panel = document.getElementById('packages-panel');
      if (!panel) return;
      var scrollPosition = getPackagesTreeScrollPosition(panel);
      panel.innerHTML = renderPackagesPanelContent();
      restorePackagesTreeScrollPosition(panel, scrollPosition);
      if (!focusNodeId) return;
      var row = findTreeRowById(panel, focusNodeId);
      if (row) focusTreeRow(row, !!preventScroll);
    }

    function renderTreeDisclosure(isExpanded, isLeaf) {
      var className = 'packages-tree-disclosure'
        + (isExpanded ? ' expanded' : '')
        + (isLeaf ? ' leaf' : '');
      return '<span class="' + className + '" aria-hidden="true"></span>';
    }

    function renderTreeIcon(kind, isExpanded) {
      var className = 'packages-tree-icon packages-tree-icon-' + kind + (isExpanded ? ' open' : '');
      return '<span class="' + className + '" aria-hidden="true"></span>';
    }

    function renderTreeBranchRow(options) {
      var className = 'packages-tree-row packages-tree-branch-row ' + options.rowClassName;
      return '<button class="' + className + '"'
        + ' data-tree-node-id="' + escape(options.branchId) + '"'
        + ' data-tree-branch-id="' + escape(options.branchId) + '"'
        + (options.parentBranchId ? ' data-tree-parent-branch-id="' + escape(options.parentBranchId) + '"' : '')
        + ' role="treeitem"'
        + ' aria-expanded="' + (options.isExpanded ? 'true' : 'false') + '"'
        + ' aria-level="' + options.level + '"'
        + ' style="--packages-tree-level:' + options.level + ';">'
        + renderTreeDisclosure(options.isExpanded, false)
        + renderTreeIcon(options.iconKind, options.isExpanded)
        + '<span class="packages-tree-label" title="' + escape(options.title || options.label) + '">'
        + escape(options.label)
        + '</span>'
        + '</button>';
    }

    function renderTreeFileRow(node, level, parentBranchId) {
      var file = node.file;
      var isSelected = state.selectedPackageFileId === file.id;
      return '<button class="packages-tree-row packages-tree-file-row' + (isSelected ? ' selected' : '') + '"'
        + ' data-tree-node-id="' + escape(getFileTreeNodeId(file)) + '"'
        + ' data-tree-parent-branch-id="' + escape(parentBranchId) + '"'
        + ' data-package-file-id="' + escape(file.id) + '"'
        + ' role="treeitem"'
        + ' aria-level="' + level + '"'
        + ' aria-selected="' + (isSelected ? 'true' : 'false') + '"'
        + ' style="--packages-tree-level:' + level + ';">'
        + renderTreeDisclosure(false, true)
        + renderTreeIcon('file', false)
        + '<span class="packages-tree-label" title="' + escape(node.path) + '">' + escape(node.name) + '</span>'
        + '</button>';
    }

    function renderPackageTreeNodes(entry, nodes, level, parentBranchId, autoExpandedBranchIds) {
      return nodes.map(function(node) {
        if (node.kind === 'file') {
          return renderTreeFileRow(node, level, parentBranchId);
        }

        var branchId = getFolderBranchId(entry, node);
        var isExpanded = isTreeBranchExpanded(branchId, autoExpandedBranchIds);
        var childrenHtml = isExpanded
          ? '<div class="packages-tree-children" role="group">'
            + renderPackageTreeNodes(entry, node.children || [], level + 1, branchId, autoExpandedBranchIds)
            + '</div>'
          : '';

        return '<div class="packages-tree-branch">'
          + renderTreeBranchRow({
            branchId: branchId,
            parentBranchId: parentBranchId,
            level: level,
            isExpanded: isExpanded,
            iconKind: 'folder',
            label: node.name,
            title: node.path,
            rowClassName: 'packages-tree-folder-row',
          })
          + childrenHtml
          + '</div>';
      }).join('');
    }

    function renderPackageEntryTree(entryView) {
      var entry = entryView.entry;
      var branchId = getPackageRootBranchId(entry);
      var isExpanded = isTreeBranchExpanded(branchId, entryView.autoExpandedBranchIds);
      var childrenHtml = isExpanded
        ? '<div class="packages-tree-children" role="group">'
          + renderPackageTreeNodes(entry, entryView.nodes, 2, branchId, entryView.autoExpandedBranchIds)
          + '</div>'
        : '';

      return '<div class="packages-tree-branch packages-tree-package">'
        + renderTreeBranchRow({
          branchId: branchId,
          parentBranchId: '',
          level: 1,
          isExpanded: isExpanded,
          iconKind: 'package',
          label: getPackageTreeLabel(entry),
          title: entry.displayName,
          rowClassName: 'packages-tree-package-row',
        })
        + childrenHtml
        + '</div>';
    }

    function renderPackagesPanelContent() {
      var appNames = getPackageBrowserAppNames();
      if (appNames.length === 0) {
        return '<div class="packages-empty">No attached debug sessions are available.</div>';
      }

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

      var visiblePackageViews = getVisiblePackageViews();
      if (visiblePackageViews.length === 0) {
        return errorBox + '<div class="packages-empty">No packages or files match the current filter.</div>';
      }

      return errorBox
        + '<div class="packages-tree" role="tree" aria-label="Loaded package sources">'
        + visiblePackageViews.map(renderPackageEntryTree).join('')
        + '</div>';
    }

    function renderPackagesRefreshButton() {
      var buttonInnerHtml = state.packageBrowserLoading
        ? '<span class="spinner packages-refresh-spinner"></span><span>Reload</span>'
        : '<span aria-hidden="true">&#8635;</span><span>Reload</span>';
      var title = 'Reload packages';
      return '<button class="gear-btn packages-refresh-btn" id="btn-refresh-packages"'
        + ' title="' + title + '" aria-label="' + title + '"'
        + (state.packageBrowserLoading ? ' disabled' : '')
        + '>'
        + buttonInnerHtml
        + '</button>';
    }

    function renderPackagesScreen() {
      var appNames = getPackageBrowserAppNames();
      var options = appNames.map(function(appName) {
        var selected = appName === state.packageBrowserAppName ? ' selected' : '';
        return '<option value="' + escape(appName) + '"' + selected + '>' + escape(appName) + '</option>';
      }).join('');

      return \`
        <div class="ready-layout">
          <div class="packages-session-header">
            <div class="section-label packages-session-heading">Debug Session</div>
            \${renderPackagesRefreshButton()}
          </div>
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
          clearSearchPackageBranchStates();
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
        var branchBtn = e.target.closest('[data-tree-branch-id]');
        if (branchBtn) {
          var branchId = branchBtn.dataset.treeBranchId;
          if (!branchId) return;
          setTreeBranchExpanded(branchId, branchBtn.getAttribute('aria-expanded') === 'false');
          refreshPackagesPanel(branchId, true);
          return;
        }

        var fileBtn = e.target.closest('[data-package-file-id]');
        if (!fileBtn || !state.packageBrowserAppName) return;
        var file = findPackageFileById(fileBtn.dataset.packageFileId);
        if (!file) return;
        state.selectedPackageFileId = file.id;
        refreshPackagesPanel(getFileTreeNodeId(file), true);
        vscode.postMessage({
          type: 'OPEN_PACKAGE_SOURCE',
          payload: {
            appName: state.packageBrowserAppName,
            source: file.source,
          },
        });
      });

      panel.addEventListener('keydown', function(e) {
        var row = e.target.closest('[data-tree-node-id]');
        if (!row) return;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusAdjacentTreeRow(panel, row, 1);
          return;
        }

        if (e.key === 'ArrowUp') {
          e.preventDefault();
          focusAdjacentTreeRow(panel, row, -1);
          return;
        }

        if (e.key === 'Home') {
          e.preventDefault();
          focusBoundaryTreeRow(panel, 0);
          return;
        }

        if (e.key === 'End') {
          e.preventDefault();
          var rows = getVisibleTreeRows(panel);
          if (rows.length > 0) rows[rows.length - 1].focus();
          return;
        }

        var branchId = row.dataset.treeBranchId;
        if (e.key === 'ArrowRight' && branchId) {
          e.preventDefault();
          if (row.getAttribute('aria-expanded') === 'false') {
            setTreeBranchExpanded(branchId, true);
            refreshPackagesPanel(branchId, true);
            return;
          }
          focusFirstChildTreeRow(panel, branchId);
          return;
        }

        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (branchId && row.getAttribute('aria-expanded') === 'true') {
            setTreeBranchExpanded(branchId, false);
            refreshPackagesPanel(branchId, true);
            return;
          }
          focusParentTreeRow(panel, row);
        }
      });
    }
  `;
}
