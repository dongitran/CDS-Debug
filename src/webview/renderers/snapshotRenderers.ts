/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getSnapshotRenderersScript(): string {
  return `
    function formatSnapshotTimestamp(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour12: false });
    }

    function formatSnapshotLocation(snapshot) {
      if (!snapshot.location) return 'unknown source';
      const src = snapshot.location.sourcePath || 'unknown source';
      const shortSrc = src.split('/').slice(-1)[0] || src;
      return shortSrc + ':' + snapshot.location.line;
    }

    function appendSnapshotVariables(lines, variables, depth, maxDepth) {
      const indent = '  '.repeat(depth);
      for (let i = 0; i < variables.length; i++) {
        const v = variables[i];
        const typeText = v.type ? ' <' + v.type + '>' : '';
        lines.push(indent + v.name + typeText + ' = ' + v.value);
        if (v.children && v.children.length > 0 && depth < maxDepth) {
          appendSnapshotVariables(lines, v.children, depth + 1, maxDepth);
        } else if (v.children && v.children.length > 0) {
          lines.push(indent + '  ...');
        }
      }
    }

    function buildSnapshotDetailText(snapshot) {
      const lines = [];
      lines.push('App: ' + snapshot.appName);
      lines.push('Session: ' + snapshot.sessionName);
      lines.push('Time: ' + new Date(snapshot.createdAt).toLocaleString());
      lines.push('Mode: ' + (snapshot.autoResumed ? 'Auto-continued' : 'Paused'));
      if (snapshot.location) {
        lines.push('Location: ' + snapshot.location.sourcePath + ':' + snapshot.location.line + ':' + snapshot.location.column);
        if (snapshot.location.functionName) lines.push('Function: ' + snapshot.location.functionName);
      }
      lines.push('');

      if (snapshot.captureError) {
        lines.push('Capture error: ' + snapshot.captureError);
        return lines.join('\\n');
      }

      if (!snapshot.scopes || snapshot.scopes.length === 0) {
        lines.push('No scopes/variables captured.');
        return lines.join('\\n');
      }

      for (let i = 0; i < snapshot.scopes.length; i++) {
        const scope = snapshot.scopes[i];
        lines.push('[' + scope.name + ']');
        if (!scope.variables || scope.variables.length === 0) {
          lines.push('  (empty)');
          lines.push('');
          continue;
        }
        appendSnapshotVariables(lines, scope.variables, 1, 3);
        lines.push('');
      }

      return lines.join('\\n');
    }

    function getSelectedBreakpointSnapshot() {
      if (!state.selectedBreakpointSnapshotId) return state.breakpointSnapshots[0] || null;
      return state.breakpointSnapshots.find(s => s.id === state.selectedBreakpointSnapshotId) || state.breakpointSnapshots[0] || null;
    }

    function renderBreakpointSnapshotsContent() {
      const snapshots = state.breakpointSnapshots || [];
      const count = snapshots.length;
      const selected = getSelectedBreakpointSnapshot();

      const header = \`
        <div class="section-label bp-section-label">
          <span>Breakpoint Snapshots</span>
          <span class="bp-count">\${count}</span>
          <button class="bp-clear-btn" id="btn-clear-breakpoint-snapshots" \${count === 0 ? 'disabled' : ''}>Clear</button>
        </div>
      \`;

      if (count === 0) {
        return header + '<div class="bp-empty">No breakpoint snapshots yet. When a breakpoint is hit, context will appear here.</div>';
      }

      const listHtml = snapshots.map(function(snapshot) {
        const selectedClass = selected && selected.id === snapshot.id ? ' selected' : '';
        const modeBadge = snapshot.autoResumed ? 'auto' : 'paused';
        return \`
          <button class="bp-item\${selectedClass}" data-breakpoint-snapshot-id="\${escape(snapshot.id)}"
            aria-label="Open breakpoint snapshot for \${escape(snapshot.appName)}">
            <span class="bp-item-top">
              <span class="bp-item-app">\${escape(snapshot.appName)}</span>
              <span class="bp-item-mode \${snapshot.autoResumed ? 'mode-auto' : 'mode-paused'}">\${modeBadge}</span>
            </span>
            <span class="bp-item-meta">\${escape(formatSnapshotLocation(snapshot))} • \${escape(formatSnapshotTimestamp(snapshot.createdAt))}</span>
          </button>
        \`;
      }).join('');

      const detailText = selected ? buildSnapshotDetailText(selected) : 'No snapshot selected.';

      return \`
        \${header}
        <div class="bp-grid">
          <div class="bp-list">\${listHtml}</div>
          <div class="bp-detail-wrap">
            <div class="bp-detail-title">Snapshot Detail</div>
            <pre class="bp-detail">\${escape(detailText)}</pre>
          </div>
        </div>
      \`;
    }

    function refreshBreakpointSnapshotsPanel() {
      const panel = document.getElementById('breakpoint-snapshots-panel');
      if (!panel) return;
      panel.innerHTML = renderBreakpointSnapshotsContent();
    }

    function renderBreakpointSnapshotsScreen() {
      const snapshotCount = state.breakpointSnapshots.length;
      const snapshotSummary = snapshotCount === 1
        ? '1 snapshot captured'
        : snapshotCount + ' snapshots captured';

      return \`
        <div class="ready-layout">
          <div class="step-header">
            <span class="step-title">Breakpoint Snapshots</span>
            <span class="radio-desc">\${escape(snapshotSummary)}</span>
          </div>
          <div id="breakpoint-snapshots-panel" class="bp-panel bp-panel-screen">\${renderBreakpointSnapshotsContent()}</div>
          <div class="footer" style="padding-top:0">
            <button class="btn bp-back-btn" id="btn-back-breakpoint-snapshots">&#8592; Back to Launcher</button>
          </div>
        </div>
      \`;
    }
  `;
}
