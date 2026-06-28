/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getLoginRenderersScript(): string {
  return `
    function renderLoggingIn() {
      const cancelBtn = state.isReconnecting ? '' : \`
        <div style="height:16px"></div>
        <button class="btn btn-secondary" id="btn-cancel-login">&#8592; Cancel</button>
      \`;
      const headingText = state.isReconnecting
        ? 'Session expired. Reconnecting\u2026'
        : 'Logging in\u2026';
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          \${headingText}
        </div>
        <div class="radio-desc" style="text-align:center;margin-top:4px">\${escape(state.apiEndpoint)}</div>
        \${cancelBtn}
      \`;
    }

    function renderSelectOrg() {
      const items = state.orgs.map(org => \`
        <label class="org-item \${org === state.selectedOrg ? 'selected' : ''}">
          <input type="radio" name="cf-org" value="\${escape(org)}"
            \${org === state.selectedOrg ? 'checked' : ''} />
          <span class="org-item-name" title="\${escape(org)}">\${escape(org)}</span>
        </label>
      \`).join('');

      return \`
        <div class="step-header">
          <span class="step-badge">2/3</span>
          <span class="step-title">Select CF Org</span>
        </div>
        <div class="info-box">Choose the Cloud Foundry org you want to debug.</div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">CF Org</div>
        <div class="org-list">
          \${items || \`<div class="org-list-empty">No orgs found.</div>\`}
        </div>
        <div style="height:10px"></div>
        <button class="btn" id="btn-next-org" \${!state.selectedOrg ? 'disabled' : ''}>Next &rarr;</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-region">Back</button>
      \`;
    }

    function renderLoadingSpaces() {
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          Loading spaces for <strong>\${escape(state.selectedOrg)}</strong>&hellip;
        </div>
        <div style="height:16px"></div>
        <button class="btn btn-secondary" id="btn-back-space-org">&#8592; Back</button>
      \`;
    }

    function renderSelectSpace() {
      const spaces = state.selectedOrg ? (state.spacesByOrg[state.selectedOrg] || []) : [];
      const items = spaces.map(space => \`
        <label class="space-item \${space === state.selectedSpace ? 'selected' : ''}">
          <input type="radio" name="cf-space" value="\${escape(space)}"
            \${space === state.selectedSpace ? 'checked' : ''} />
          <span class="space-item-name" title="\${escape(space)}">\${escape(space)}</span>
        </label>
      \`).join('');

      return \`
        <div class="step-header">
          <span class="step-badge">2/3</span>
          <span class="step-title">Select CF Space</span>
        </div>
        <div class="info-box">Org: <code>\${escape(state.selectedOrg ?? '')}</code></div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">CF Space</div>
        <div class="space-list">
          \${items || \`<div class="org-list-empty">No spaces found.</div>\`}
        </div>
        <div style="height:10px"></div>
        <button class="btn" id="btn-next-space" \${!state.selectedSpace ? 'disabled' : ''}>Next &rarr;</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-space-org">Back</button>
      \`;
    }

    function renderSelectFolder() {
      const folderDisplay = state.selectedFolder
        ? \`<div class="info-box" style="word-break:break-all"><code>\${escape(state.selectedFolder)}</code></div>\`
        : \`<div class="radio-desc" style="margin-bottom:8px">No folder selected yet.</div>\`;

      return \`
        <div class="step-header">
          <span class="step-badge">3/3</span>
          <span class="step-title">Select Local Folder</span>
        </div>
        <div class="info-box">
          Org: <code>\${escape(state.selectedOrg ?? '')}</code><br>
          Space: <code>\${escape(state.selectedSpace ?? '')}</code>
        </div>
        \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
        <div class="section-label">Local Group Folder</div>
        \${folderDisplay}
        <button class="btn btn-secondary" id="btn-browse-folder">Browse&hellip;</button>
        <div style="height:10px"></div>
        <button class="btn" id="btn-save-mapping" \${!state.selectedFolder ? 'disabled' : ''}>Save &amp; Continue</button>
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-back-select-org">Back</button>
      \`;
    }

    function renderLoadingApps() {
      const targetText = state.selectedSpace
        ? state.selectedOrg + ' / ' + state.selectedSpace
        : state.selectedOrg;
      return \`
        <div style="text-align:center;padding:24px 0">
          <span class="spinner"></span>
          Loading apps for <strong>\${escape(targetText)}</strong>&hellip;
        </div>
        <div style="height:16px"></div>
        <button class="btn btn-secondary" id="btn-cancel-load-apps">&#8592; Cancel</button>
      \`;
    }
  `;
}
