/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getActiveSessionRenderersScript(): string {
  return `
    function getStatusInnerHtml(session) {
      if (session.status === 'PENDING') {
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">Preparing\u2026</span>';
      }
      if (session.status === 'DISCOVERING') {
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">Discovering remote folder\u2026</span>';
      }
      if (session.status === 'SSH_ENABLING') {
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">Enabling SSH\u2026</span>';
      }
      if (session.status === 'SSH_RESTARTING') {
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">Restarting app\u2026</span>';
      }
      if (session.status === 'TUNNELING') {
        const text = LOADING_MESSAGES[session.msgPhase] || 'Connecting...';
        return '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>'
          + '<span class="status-text-anim">' + escape(text) + '</span>';
      }
      if (session.status === 'ATTACHED') {
        const noSrc = session.noLocalFolder
          ? '<span class="active-card-no-src" title="No local source folder found \u2014 debug console only">no src</span>'
          : '';
        return '<span style="color:var(--vscode-testing-iconPassed);margin-right:6px">&#9679;</span>'
          + '<span class="status-text-anim">Debugger Attached</span>'
          + noSrc;
      }
      if (session.status === 'ERROR') {
        return '<span style="color:var(--vscode-testing-iconFailed);margin-right:6px">&#10006;</span>'
          + '<span class="status-text-anim">' + escape(session.message || 'Connection Error') + '</span>';
      }
      return '';
    }

    function buildPackagesButtonHtml(appName) {
      return '<button class="active-packages-btn" data-packages-app="' + escape(appName) + '"'
        + ' title="Open loaded packages" aria-label="Open packages for ' + escape(appName) + '">'
        + 'Package</button>';
    }

    function renderActiveCard(appName) {
      const session = state.activeSessions[appName];
      const portText = session.port ? '<span class="active-card-port">:' + session.port + '</span>' : '';
      const packagesBtn = session.status === 'ATTACHED'
        ? buildPackagesButtonHtml(appName)
        : '';

      const retryBtn = session.status === 'ERROR' ? \`
        <button class="active-retry-btn" data-retry-app="\${escape(appName)}"
          title="Retry connection" aria-label="Retry debug for \${escape(appName)}">&#8635;</button>
      \` : '';

      return \`
        <div class="active-card" data-app-name="\${escape(appName)}" data-status="\${escape((session.status || '').toLowerCase())}">
          <div class="active-card-main">
            <div class="active-card-title" title="\${escape(appName)}">\${escape(appName)}\${portText}</div>
            <div class="active-card-status">\${getStatusInnerHtml(session)}</div>
          </div>
          \${packagesBtn}
          \${retryBtn}
          <button class="active-stop-btn" data-stop-app="\${escape(appName)}"
            title="Stop Debug Session" aria-label="Stop debug for \${escape(appName)}">&#9632;</button>
        </div>
      \`;
    }

    function renderActiveSessionsContent() {
      const activeAppNames = Object.keys(state.activeSessions);
      if (activeAppNames.length === 0) return '';
      const stopAllBtn = activeAppNames.length > 1 ? \`
        <button class="stop-all-btn" id="btn-stop-all-sessions" aria-label="Stop all debug sessions">
          &#9632; Stop All Sessions (\${activeAppNames.length})
        </button>
      \` : '';
      return \`
        <div class="section-label" style="display:flex;align-items:center;gap:6px;margin:8px 0 6px">
          <span style="color:var(--vscode-testing-iconPassed)">&#9679;</span> Active Sessions
        </div>
        \${stopAllBtn}
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
          \${activeAppNames.map(renderActiveCard).join('')}
        </div>
        <div class="divider"></div>
      \`;
    }

    function refreshActiveSessionsPanel() {
      const panel = document.getElementById('active-sessions-panel');
      if (!panel) return;

      const activeAppNames = Object.keys(state.activeSessions);

      if (activeAppNames.length === 0) {
        panel.innerHTML = '';
        return;
      }

      const existingCards = Array.from(panel.querySelectorAll('[data-app-name]'));
      const existingNames = existingCards.map(function(c) { return c.dataset.appName; });
      const sameSet = activeAppNames.length === existingNames.length
        && activeAppNames.every(function(n) { return existingNames.indexOf(n) !== -1; });

      if (!sameSet) {
        // Session added or removed — full rebuild with slide-in animation
        panel.innerHTML = renderActiveSessionsContent();
        return;
      }

      // Same set of sessions — update only the status part of each card (no animation)
      for (let i = 0; i < activeAppNames.length; i++) {
        const appName = activeAppNames[i];
        const session = state.activeSessions[appName];
        let card = null;
        for (let j = 0; j < existingCards.length; j++) {
          if (existingCards[j].dataset.appName === appName) { card = existingCards[j]; break; }
        }
        if (!card) continue;

        const statusEl = card.querySelector('.active-card-status');
        if (statusEl) {
          const newHtml = getStatusInnerHtml(session);
          if (statusEl.innerHTML !== newHtml) statusEl.innerHTML = newHtml;
        }
        // Keep data-status in sync for CSS status-accent styling
        card.dataset.status = (session.status || '').toLowerCase();

        const existingPackagesBtn = card.querySelector('[data-packages-app]');
        const stopBtn = card.querySelector('[data-stop-app]');

        if (session.status === 'ATTACHED' && !existingPackagesBtn && stopBtn) {
          const tmp = document.createElement('div');
          tmp.innerHTML = buildPackagesButtonHtml(appName);
          stopBtn.parentNode.insertBefore(tmp.firstChild, stopBtn);
        } else if (session.status !== 'ATTACHED' && existingPackagesBtn) {
          existingPackagesBtn.remove();
        }

        // Retry button: show on ERROR, hide otherwise
        const existingRetryBtn = card.querySelector('[data-retry-app]');
        if (session.status === 'ERROR' && !existingRetryBtn && stopBtn) {
          const tmp = document.createElement('div');
          tmp.innerHTML = '<button class="active-retry-btn" data-retry-app="' + escape(appName) + '"'
            + ' title="Retry connection" aria-label="Retry debug for ' + escape(appName) + '">&#8635;</button>';
          stopBtn.parentNode.insertBefore(tmp.firstChild, stopBtn);
        } else if (session.status !== 'ERROR' && existingRetryBtn) {
          existingRetryBtn.remove();
        }
      }
    }
  `;
}
