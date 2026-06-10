import * as vscode from 'vscode';
import {
  appWatchdogEvents,
  getWatchdogSnapshot,
  stopWatchingApp,
  sweepWatchedApps,
  WATCHDOG_CHANGED_EVENT,
  type AppWatchdogSnapshot,
} from '../core/appWatchdog';
import { logWarn } from '../core/logger';

/**
 * Detail page behind the watchdog status bar item: lists every watched app with
 * its live/stuck state, route, and watch window, and lets the user re-check or
 * stop watching individual apps.
 */
export class AppWatchdogPanel {
  private static current: AppWatchdogPanel | undefined;
  private static readonly viewType = 'cdsDebug.appWatchdog';

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (AppWatchdogPanel.current) {
      AppWatchdogPanel.current.panel.reveal(column);
      AppWatchdogPanel.current.postSnapshot(getWatchdogSnapshot());
      void sweepWatchedApps().catch(() => undefined);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AppWatchdogPanel.viewType,
      'CDS Debug: App Watchdog',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    AppWatchdogPanel.current = new AppWatchdogPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = buildHtml();

    const onChanged = (snapshot: AppWatchdogSnapshot): void => {
      this.postSnapshot(snapshot);
    };
    appWatchdogEvents.on(WATCHDOG_CHANGED_EVENT, onChanged);
    this.disposables.push(new vscode.Disposable(() => {
      appWatchdogEvents.off(WATCHDOG_CHANGED_EVENT, onChanged);
    }));

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => {
      this.dispose();
    }, null, this.disposables);

    // Refresh as soon as the page is open so the user never stares at stale state.
    void sweepWatchedApps().catch((err: unknown) => {
      logWarn(`[AppWatchdog] Panel-triggered sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private postSnapshot(snapshot: AppWatchdogSnapshot): void {
    void this.panel.webview.postMessage({
      type: 'WATCHDOG_STATE',
      payload: { snapshot },
    });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const message = raw as { type?: unknown; payload?: unknown };
    switch (message.type) {
      case 'WATCHDOG_READY':
        // The snapshot cannot be pushed before the webview registers its message
        // listener — the page announces readiness and gets the current state.
        this.postSnapshot(getWatchdogSnapshot());
        return;
      case 'WATCHDOG_CHECK_NOW':
        void sweepWatchedApps().catch((err: unknown) => {
          logWarn(`[AppWatchdog] Manual check failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      case 'WATCHDOG_STOP_WATCHING': {
        const key = (message.payload as { key?: unknown } | undefined)?.key;
        if (typeof key !== 'string') return;
        void stopWatchingApp(key).catch((err: unknown) => {
          logWarn(`[AppWatchdog] Stop watching failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      default:
        return;
    }
  }

  private dispose(): void {
    AppWatchdogPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function buildHtml(): string {
  const nonce = generateNonce();
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CDS Debug: App Watchdog</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
      padding: 28px 36px 48px;
    }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
    .title { font-size: 20px; font-weight: 700; }
    .subtitle { color: var(--vscode-descriptionForeground); font-size: 12.5px; margin-bottom: 18px; max-width: 760px; }
    .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 3px; padding: 5px 12px; cursor: pointer; font-size: 12.5px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid var(--vscode-sideBar-border, #3c3c3c);
      border-radius: 12px; padding: 2px 10px; font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .chip strong { color: var(--vscode-foreground); }
    .chip.bad strong { color: var(--vscode-inputValidation-errorForeground, #f48771); }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-sideBar-border, #3c3c3c);
      padding: 6px 10px;
    }
    td { padding: 9px 10px; border-bottom: 1px solid var(--vscode-sideBar-border, #2d2d2d); vertical-align: top; }
    tr.unresponsive td { background: rgba(244, 135, 113, 0.07); }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; }
    .dot.ok { background: var(--vscode-testing-iconPassed, #73c991); }
    .dot.bad { background: var(--vscode-inputValidation-errorForeground, #f48771); }
    .dot.unknown { background: var(--vscode-descriptionForeground, #8a8a8a); }
    .dot.debug { background: var(--vscode-debugIcon-startForeground, #89d185); opacity: 0.85; }
    .status-label.bad { color: var(--vscode-inputValidation-errorForeground, #f48771); font-weight: 600; }
    .app-name { font-weight: 600; }
    .target { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .reason { color: var(--vscode-inputValidation-errorForeground, #f48771); font-size: 12px; margin-top: 3px; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 11.5px; margin-top: 3px; font-style: italic; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; word-break: break-all; }
    a:hover { text-decoration: underline; }
    .empty {
      border: 1px dashed var(--vscode-sideBar-border, #3c3c3c); border-radius: 6px;
      padding: 28px; text-align: center; color: var(--vscode-descriptionForeground);
    }
    .banner {
      border-left: 3px solid var(--vscode-inputValidation-warningBorder, #e2c08d);
      background: var(--vscode-inputValidation-warningBackground, rgba(226,192,141,0.1));
      padding: 8px 12px; border-radius: 0 4px 4px 0; margin-bottom: 16px; font-size: 12.5px;
    }
    .stop-btn { font-size: 11.5px; padding: 3px 9px; white-space: nowrap; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">🛡️ App Watchdog</div>
  </div>
  <div class="subtitle">
    Every app started through <strong>Start Debug Sessions</strong> is pinged on its mapped route for a
    fixed watch window. If a route stops answering — typically a leftover breakpoint freezing the remote
    Node process — it shows up here and in the status bar, so a stuck Cloud Foundry app never goes unnoticed.
    Apps with a live debug session in this window are excluded from checks while you debug them: pausing on
    your own breakpoint is expected, not an incident.
  </div>
  <div id="app"><div class="empty">Loading…</div></div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      let state = null;

      function esc(value) {
        return String(value)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      function fmtAgo(ts) {
        if (!ts) return '—';
        const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (sec < 5) return 'just now';
        if (sec < 60) return sec + 's ago';
        const min = Math.round(sec / 60);
        if (min < 60) return min + ' min ago';
        const hrs = Math.round(min / 6) / 10;
        return hrs + ' h ago';
      }

      function fmtRemaining(expiresAt) {
        const ms = expiresAt - Date.now();
        if (ms <= 0) return 'expiring';
        const min = Math.round(ms / 60000);
        if (min < 60) return min + ' min left';
        return (Math.round(min / 6) / 10) + ' h left';
      }

      function statusCell(app, watchdogEnabled) {
        if (!watchdogEnabled) {
          return '<span class="dot unknown"></span><span class="meta">paused</span>';
        }
        if (app.monitorState === 'debug-in-progress') {
          return '<span class="dot debug"></span><span class="meta">Debugging in this window — checks paused</span>';
        }
        if (app.monitorState === 'other-window') {
          return '<span class="dot unknown"></span><span class="meta">Watched by another VS Code window</span>';
        }
        if (!app.lastOutcome) {
          return '<span class="dot unknown"></span><span class="meta">checking…</span>';
        }
        if (app.unresponsive) {
          return '<span class="dot bad"></span><span class="status-label bad">Not responding</span>';
        }
        if (app.consecutiveFailures > 0) {
          return '<span class="dot unknown"></span><span class="meta">1 failed ping — confirming…</span>';
        }
        return '<span class="dot ok"></span><span>Responding</span>';
      }

      function renderRow(app, watchdogEnabled) {
        const reason = app.unresponsive && app.lastOutcome && !app.lastOutcome.ok
          ? '<div class="reason">' + esc(app.lastOutcome.reason) + ' (' + app.consecutiveFailures + ' consecutive failures)</div>'
          : '';
        return '<tr class="' + (app.unresponsive ? 'unresponsive' : '') + '">'
          + '<td>' + statusCell(app, watchdogEnabled) + reason + '</td>'
          + '<td><div class="app-name">' + esc(app.appName) + '</div>'
          +   '<div class="target">' + esc(app.region) + ' / ' + esc(app.org) + ' / ' + esc(app.space) + '</div></td>'
          + '<td><a href="' + esc(app.url) + '" title="Open in browser">' + esc(app.url.replace(/^https?:\\/\\//, '')) + '</a></td>'
          + '<td class="meta">started ' + fmtAgo(app.startedAt) + '<br/>' + esc(fmtRemaining(app.expiresAt)) + '</td>'
          + '<td class="meta">' + fmtAgo(app.lastCheckedAt) + '</td>'
          + '<td><button class="btn btn-secondary stop-btn" data-action="stop" data-key="' + esc(app.key) + '">Stop watching</button></td>'
          + '</tr>';
      }

      function render() {
        const root = document.getElementById('app');
        if (!state) { root.innerHTML = '<div class="empty">Loading…</div>'; return; }
        const snap = state.snapshot;

        const banner = snap.enabled ? '' :
          '<div class="banner">The App Watchdog is disabled (<code>cdsDebug.appWatchdog.enabled</code>). '
          + 'Watched apps are listed but not pinged.</div>';

        const toolbar =
          '<div class="toolbar">'
          + '<button class="btn" data-action="check-now"' + (snap.enabled ? '' : ' disabled') + '>↻ Check now</button>'
          + '<span class="chip">watching <strong>' + snap.apps.length + '</strong></span>'
          + '<span class="chip' + (snap.unresponsiveCount > 0 ? ' bad' : '') + '">not responding <strong>'
          +   snap.unresponsiveCount + '</strong></span>'
          + '<span class="chip">every <strong>' + snap.pingIntervalSeconds + 's</strong></span>'
          + '<span class="chip">watch window <strong>' + snap.watchDurationHours + 'h</strong></span>'
          + '</div>';

        if (snap.apps.length === 0) {
          root.innerHTML = banner + toolbar
            + '<div class="empty">No apps are being watched right now.<br/>'
            + 'Apps appear here automatically when you click <strong>Start Debug Sessions</strong> '
            + 'and stay for ' + esc(snap.watchDurationHours) + ' hours.</div>';
          return;
        }

        root.innerHTML = banner + toolbar
          + '<table><thead><tr>'
          + '<th style="width:24%">Status</th><th style="width:22%">App</th><th>Route</th>'
          + '<th style="width:13%">Watch window</th><th style="width:9%">Last check</th><th style="width:10%"></th>'
          + '</tr></thead><tbody>'
          + snap.apps.map(function (app) { return renderRow(app, snap.enabled); }).join('')
          + '</tbody></table>';
      }

      document.addEventListener('click', function (event) {
        const el = event.target.closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'check-now') vscode.postMessage({ type: 'WATCHDOG_CHECK_NOW' });
        if (action === 'stop') vscode.postMessage({ type: 'WATCHDOG_STOP_WATCHING', payload: { key: el.getAttribute('data-key') } });
      });

      window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg && msg.type === 'WATCHDOG_STATE') {
          state = msg.payload;
          render();
        }
      });

      // Keep relative times fresh even when no sweep happens in between.
      setInterval(function () { if (state) render(); }, 15000);

      vscode.postMessage({ type: 'WATCHDOG_READY' });
    })();
  </script>
</body>
</html>`;
}

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
