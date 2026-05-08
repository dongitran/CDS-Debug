import type * as vscode from 'vscode';
import type { LogsExtensionMessage, LogsWebviewMessage } from '../types/index';
import { cfLogsManager } from '../core/cfLogsManager';
import { getConfig, mappingSpace } from '../storage/configStore';
import { cfTarget } from '../core/cfClient';
import { logError, logInfo, logWarn } from '../core/logger';
import { selectPreferredOrgMapping } from './mappingState';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getLogsHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>CF Logs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, monospace);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .toolbar-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-right: 2px;
    }
    select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      font-size: 12px;
      padding: 2px 4px;
      border-radius: 2px;
      min-width: 160px;
    }
    button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 3px 8px;
      font-size: 12px;
      border-radius: 2px;
      cursor: pointer;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: default; }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .streaming-badge {
      font-size: 10px;
      background: var(--vscode-testing-iconPassed, #4caf50);
      color: #fff;
      padding: 1px 5px;
      border-radius: 3px;
    }
    .log-output {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      line-height: 1.5;
      white-space: pre;
    }
    .log-line { display: block; }
    .log-line.err { color: var(--vscode-testing-iconFailed, #f44336); }
    .log-line.warn { color: var(--vscode-editorWarning-foreground, #ff9800); }
    .log-empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 16px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
    }
    .status-bar {
      padding: 2px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="toolbar-label">App:</span>
    <select id="app-select"><option value="">— select app —</option></select>
    <button id="btn-start" class="primary" disabled>&#9654; Start</button>
    <button id="btn-stop" disabled>&#9632; Stop</button>
    <button id="btn-clear" disabled>&#128465; Clear</button>
    <span id="streaming-badge" class="streaming-badge" style="display:none">&#9679; streaming</span>
  </div>
  <div class="log-output" id="log-output">
    <div class="log-empty" id="log-empty">Select an app and click Start to stream logs.</div>
  </div>
  <div class="status-bar" id="status-bar">Ready</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentApp = '';
    let isStreaming = false;
    let autoScroll = true;
    let lineCount = 0;
    const MAX_LINES = 5000;

    const appSelect = document.getElementById('app-select');
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    const btnClear = document.getElementById('btn-clear');
    const logOutput = document.getElementById('log-output');
    const logEmpty = document.getElementById('log-empty');
    const statusBar = document.getElementById('status-bar');
    const streamingBadge = document.getElementById('streaming-badge');

    function updateButtons() {
      const hasApp = !!currentApp;
      btnStart.disabled = !hasApp || isStreaming;
      btnStop.disabled = !hasApp || !isStreaming;
      btnClear.disabled = lineCount === 0;
      streamingBadge.style.display = isStreaming ? 'inline-block' : 'none';
      statusBar.textContent = currentApp
        ? (isStreaming ? 'Streaming: ' + currentApp : 'Selected: ' + currentApp)
        : 'Ready';
    }

    function appendLine(text) {
      if (logEmpty) logEmpty.style.display = 'none';

      // Trim oldest lines if we exceed MAX_LINES
      if (lineCount >= MAX_LINES) {
        const firstLine = logOutput.querySelector('.log-line:not(#log-empty)');
        if (firstLine) firstLine.remove();
        lineCount--;
      }

      const span = document.createElement('span');
      span.className = 'log-line';
      const lower = text.toLowerCase();
      if (lower.includes(' err]') || lower.includes('[err') || lower.includes('error')) {
        span.classList.add('err');
      } else if (lower.includes(' out]') === false && (lower.includes('warn') || lower.includes('[wrn'))) {
        span.classList.add('warn');
      }
      span.textContent = text;
      logOutput.appendChild(span);
      lineCount++;

      if (autoScroll) {
        logOutput.scrollTop = logOutput.scrollHeight;
      }
    }

    appSelect.addEventListener('change', function() {
      currentApp = appSelect.value;
      updateButtons();
    });

    btnStart.addEventListener('click', function() {
      if (!currentApp || isStreaming) return;
      vscode.postMessage({ type: 'LOGS_START', payload: { appName: currentApp } });
    });

    btnStop.addEventListener('click', function() {
      if (!currentApp || !isStreaming) return;
      vscode.postMessage({ type: 'LOGS_STOP', payload: { appName: currentApp } });
    });

    btnClear.addEventListener('click', function() {
      const lines = logOutput.querySelectorAll('.log-line');
      lines.forEach(function(l) { l.remove(); });
      lineCount = 0;
      if (logEmpty) logEmpty.style.display = 'block';
      if (currentApp) {
        vscode.postMessage({ type: 'LOGS_CLEAR', payload: { appName: currentApp } });
      }
      updateButtons();
    });

    // Pause auto-scroll when user scrolls up
    logOutput.addEventListener('scroll', function() {
      const threshold = 40;
      autoScroll = logOutput.scrollTop + logOutput.clientHeight >= logOutput.scrollHeight - threshold;
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      switch (msg.type) {
        case 'LOGS_APPS': {
          const apps = msg.payload.apps || [];
          const streaming = msg.payload.streaming || [];
          const prev = appSelect.value;
          while (appSelect.options.length > 1) appSelect.remove(1);
          apps.forEach(function(app) {
            const opt = document.createElement('option');
            opt.value = app;
            opt.textContent = app;
            if (streaming.indexOf(app) !== -1) opt.textContent += ' ●';
            appSelect.appendChild(opt);
          });
          if (apps.indexOf(prev) !== -1) appSelect.value = prev;
          else if (apps.length > 0) appSelect.value = apps[0];
          currentApp = appSelect.value;
          updateButtons();
          break;
        }
        case 'LOGS_LINE':
          if (msg.payload.appName === currentApp) {
            appendLine(msg.payload.line);
          }
          break;
        case 'LOGS_STATUS': {
          if (msg.payload.appName === currentApp) {
            isStreaming = msg.payload.streaming;
            updateButtons();
          }
          break;
        }
        case 'LOGS_ERROR':
          if (msg.payload.appName === currentApp) {
            appendLine('[ERROR] ' + msg.payload.message);
            isStreaming = false;
            updateButtons();
          }
          break;
      }
    });

    // Request app list on startup
    vscode.postMessage({ type: 'LOGS_GET_APPS' });
  </script>
</body>
</html>`;
}

export class CfLogsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'cdsDebug.logsView';

  private _view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Forward log events to the webview
    cfLogsManager.on('logLine', (appName: string, line: string) => {
      this.postLogs({ type: 'LOGS_LINE', payload: { appName, line } });
    });
    cfLogsManager.on('logError', (appName: string, message: string) => {
      this.postLogs({ type: 'LOGS_ERROR', payload: { appName, message } });
    });
    cfLogsManager.on('logEnd', (appName: string) => {
      this.postLogs({ type: 'LOGS_STATUS', payload: { appName, streaming: false } });
      // Refresh the app list so the streaming indicator updates
      this.pushAppList();
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    const nonce = getNonce();
    webviewView.webview.html = getLogsHtml(webviewView.webview.cspSource, nonce);
    webviewView.webview.onDidReceiveMessage(
      (raw: unknown) => void this.handleMessage(raw),
      undefined,
      this.context.subscriptions,
    );
  }

  /** Called from the main debug panel to start streaming logs for an app. */
  openLogsForApp(appName: string): void {
    this._view?.show(true);

    const config = getConfig();
    const mapping = config
      ? selectPreferredOrgMapping(config.orgs, config.orgGroupMappings)
      : null;
    if (!mapping) {
      logWarn(`[CfLogs] No org mapping found — cannot stream logs for ${appName}.`);
      return;
    }
    const space = mappingSpace(mapping);
    const org = mapping.cfOrg;

    if (cfLogsManager.isStreaming(appName)) {
      this.pushAppList();
      return;
    }

    logInfo(`[CfLogs] Targeting ${org}/${space} before streaming ${appName}.`);
    void cfTarget(org, space)
      .then(() => {
        cfLogsManager.startStreaming(appName);
        this.postLogs({ type: 'LOGS_STATUS', payload: { appName, streaming: true } });
        this.pushAppList();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[CfLogs] CF target failed: ${msg}`);
        this.postLogs({ type: 'LOGS_ERROR', payload: { appName, message: `CF target failed: ${msg}` } });
      });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!isLogsWebviewMessage(raw)) return;

    switch (raw.type) {
      case 'LOGS_GET_APPS':
        this.pushAppList();
        break;

      case 'LOGS_START': {
        const appName = raw.payload.appName;
        const config = getConfig();
        const mapping = config
          ? selectPreferredOrgMapping(config.orgs, config.orgGroupMappings)
          : null;
        if (!mapping) {
          this.postLogs({ type: 'LOGS_ERROR', payload: { appName, message: 'No CF org configured. Complete setup in the Debug Launcher panel first.' } });
          return;
        }
        const space = mappingSpace(mapping);
        const org = mapping.cfOrg;
        logInfo(`[CfLogs] Starting stream for ${appName} in ${org}/${space}.`);
        try {
          await cfTarget(org, space);
          cfLogsManager.startStreaming(appName);
          this.postLogs({ type: 'LOGS_STATUS', payload: { appName, streaming: true } });
          this.pushAppList();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(`[CfLogs] CF target failed for ${appName}: ${msg}`);
          this.postLogs({ type: 'LOGS_ERROR', payload: { appName, message: `CF target failed: ${msg}` } });
        }
        break;
      }

      case 'LOGS_STOP':
        cfLogsManager.stopStreaming(raw.payload.appName);
        this.postLogs({ type: 'LOGS_STATUS', payload: { appName: raw.payload.appName, streaming: false } });
        this.pushAppList();
        break;

      case 'LOGS_CLEAR':
        // Extension-side: nothing to clear (client holds the log buffer)
        break;
    }
  }

  private pushAppList(): void {
    const config = getConfig();
    const apps = config?.orgGroupMappings.flatMap(() => []) ?? [];
    // Collect apps from all org mappings — for now use cached app list if available
    const streaming = cfLogsManager.streamingApps();
    this.postLogs({ type: 'LOGS_APPS', payload: { apps, streaming } });
  }

  /** Called when a debug session status changes — auto-start streaming on ATTACHED. */
  onSessionStatus(appName: string, status: string): void {
    if (status === 'ATTACHED' && !cfLogsManager.isStreaming(appName)) {
      // Only auto-stream if the logs panel is already visible (not intrusive)
      if (this._view?.visible) {
        this.openLogsForApp(appName);
      }
    } else if (status === 'EXITED') {
      cfLogsManager.stopStreaming(appName);
    }
  }

  /** Refreshes the app list in the logs panel with a fresh set of known apps. */
  refreshApps(apps: string[]): void {
    const streaming = cfLogsManager.streamingApps();
    this.postLogs({ type: 'LOGS_APPS', payload: { apps, streaming } });
  }

  private postLogs(message: LogsExtensionMessage): void {
    void this._view?.webview.postMessage(message);
  }
}

function isLogsWebviewMessage(value: unknown): value is LogsWebviewMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as Record<string, unknown>).type === 'string'
  );
}
