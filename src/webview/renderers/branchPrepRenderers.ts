/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getBranchPrepRenderersScript(): string {
  return `
    // === BRANCH PREP SCREEN ===

    function getBranchPrepStepInfo(service) {
      var step = service.step;
      if (step === 'done') {
        return { icon: '<span class="prep-icon prep-icon-ok">&#10003;</span>', text: 'Ready' };
      }
      if (step === 'skipped') {
        return { icon: '<span class="prep-icon prep-icon-skip">&#8212;</span>', text: escape(service.message || 'No branch change needed') };
      }
      if (step === 'error') {
        return { icon: '<span class="prep-icon prep-icon-err">&#10007;</span>', text: escape(service.message || 'Error') };
      }
      var text = 'Preparing\u2026';
      if (step === 'stashing') text = 'Stashing uncommitted changes\u2026';
      else if (step === 'checking-out') text = 'Checking out branch ' + escape(service.targetBranch) + '\u2026';
      else if (step === 'installing') text = 'Running pnpm install\u2026';
      else if (step === 'building') text = 'Running pnpm build\u2026';
      return {
        icon: '<span class="spinner" style="width:11px;height:11px;border-width:1.5px"></span>',
        text: text,
      };
    }

    function renderPreparingBranches() {
      var services = state.branchPrepServices;
      var terminalSteps = ['done', 'skipped', 'error'];
      var allDone = services.length > 0 && services.every(function(s) { return terminalSteps.indexOf(s.step) !== -1; });
      var hasError = services.some(function(s) { return s.step === 'error'; });

      var rows = services.map(function(s) {
        var info = getBranchPrepStepInfo(s);
        var branchBadge = \`<span class="branch-badge">
          <span style="font-size:10px;margin-right:3px">&#x2387;</span>\${escape(s.targetBranch)}
        </span>\`;
        return \`
          <div class="prep-row">
            <div class="prep-row-top">
              <span class="prep-name" title="\${escape(s.appName)}">\${escape(s.appName)}</span>
              \${branchBadge}
            </div>
            <div class="prep-row-status">
              \${info.icon}
              <span class="prep-status-text">\${info.text}</span>
            </div>
          </div>
        \`;
      }).join('');

      var statusBlock;
      if (allDone && !hasError) {
        statusBlock = \`<div class="info-box" style="display:flex;align-items:center;gap:6px">
          <span class="spinner" style="width:11px;height:11px;border-width:1.5px"></span>
          <span>Starting debug sessions\u2026</span>
        </div>\`;
      } else if (allDone && hasError) {
        statusBlock = \`<div class="info-box" style="color:var(--vscode-descriptionForeground)">
          Some services failed. Debug will start for successful services.
        </div>\`;
      } else {
        statusBlock = \`<div class="info-box">Preparing branch environment for debugging\u2026</div>\`;
      }

      return \`
        <div class="step-header">
          <span class="step-title">Preparing Branches</span>
        </div>
        \${statusBlock}
        <div class="prep-list">
          \${rows || '<div class="org-list-empty">No services to prepare.</div>'}
        </div>
      \`;
    }
  `;
}
