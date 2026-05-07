import * as vscode from 'vscode';

interface FeatureEntry {
  icon: string;
  title: string;
  description: string;
}

interface FixEntry {
  title: string;
  description: string;
}

interface ChangelogVersion {
  version: string;
  label: string;
  features: FeatureEntry[];
  fixes: FixEntry[];
}

const CHANGELOG: ChangelogVersion[] = [
  {
    version: '0.3.60',
    label: 'v0.3.60',
    features: [
      {
        icon: '📦',
        title: 'Package Browser',
        description:
          'A new screen lets you browse every npm package loaded in an active debug session as a collapsible tree. Search by name, filter with a regex, and jump directly to any source file — no more hunting through node_modules manually.',
      },
      {
        icon: '📸',
        title: 'Breakpoint Snapshots',
        description:
          'Capture the full variable context at any breakpoint without pausing execution — CDS Debug auto-continues and accumulates snapshots in the sidebar for review after the request completes. Toggle in Settings → Breakpoint Snapshot Handling.',
      },
      {
        icon: '⚙️',
        title: 'Shared CAP Debug Config',
        description:
          'Set <code>cdsDebug.sharedCapDebugConfig</code> once in VS Code user settings to share <code>remoteRoot</code> and <code>orgBranchMap</code> across every workspace — no more copying <code>cap-debug-config.json</code> into each project.',
      },
      {
        icon: '🛡️',
        title: 'Stability & Fixes',
        description:
          'Suppressed spurious save-before-start permission errors, retry package loading when a session restarts, and corrected source map paths for generated CAP server files.',
      },
      {
        icon: '🧭',
        title: 'Dynamic Remote Roots',
        description:
          'Regex-based <code>remoteRoot</code> values now resolve per CF app before debugging starts, so generated attach configs can map services deployed under different remote folders such as <code>/usr/sample-service-a</code>.',
      },
      {
        icon: '🧩',
        title: 'Compatibility Refresh',
        description:
          'Lowered the minimum VS Code engine target to 1.112 and checked the code against an older VS Code API type baseline, while keeping the existing CF sync, ESLint, and TypeScript ESLint updates.',
      },
    ],
    fixes: [],
  },
];

export class WhatsNewPanel {
  private static current: WhatsNewPanel | undefined;
  private static readonly viewType = 'cdsDebug.whatsNew';

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = buildHtml();
    this.panel.onDidDispose(() => { this.dispose(); }, null, this.disposables);
  }

  static show(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (WhatsNewPanel.current) {
      WhatsNewPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      WhatsNewPanel.viewType,
      "What's New in CDS Debug",
      column,
      {
        enableScripts: false,
        retainContextWhenHidden: false,
        localResourceRoots: [context.extensionUri],
      },
    );

    WhatsNewPanel.current = new WhatsNewPanel(panel);
  }

  private dispose(): void {
    WhatsNewPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function buildHtml(): string {
  const entry = CHANGELOG[0];
  if (!entry) return '<html><body>No changelog available.</body></html>';

  const featuresHtml = entry.features
    .map(
      (f) => `
    <div class="card">
      <div class="card-icon">${f.icon}</div>
      <div class="card-body">
        <div class="card-title">${f.title}</div>
        <div class="card-desc">${f.description}</div>
      </div>
    </div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <title>What's New in CDS Debug</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.6;
      padding: 0 0 48px 0;
    }

    .hero {
      background: var(--vscode-editor-background);
      border-top: 3px solid var(--vscode-focusBorder, #0078d4);
      border-bottom: 1px solid var(--vscode-sideBar-border, #3c3c3c);
      padding: 40px 48px 36px;
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .hero-icon {
      font-size: 48px;
      line-height: 1;
      flex-shrink: 0;
    }

    .hero-text {}

    .hero-title-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }

    .hero-title {
      font-size: 26px;
      font-weight: 700;
      color: var(--vscode-foreground);
      line-height: 1.2;
    }

    .hero-subtitle {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }

    .version-badge {
      display: inline-block;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }

    .content {
      max-width: 820px;
      margin: 0 auto;
      padding: 36px 48px 0;
    }

    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 16px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-sideBar-border, #3c3c3c);
    }

    .features-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-bottom: 40px;
    }

    .card {
      display: flex;
      gap: 14px;
      background: var(--vscode-sideBar-background, #252526);
      border: 1px solid var(--vscode-sideBar-border, #3c3c3c);
      border-radius: 6px;
      padding: 16px;
      transition: border-color 0.15s;
    }

    .card:hover {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .card-icon {
      font-size: 22px;
      line-height: 1;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .card-body {}

    .card-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 5px;
      color: var(--vscode-foreground);
    }

    .card-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }

    .card-desc code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      background: var(--vscode-textPreformat-background, rgba(128,128,128,0.15));
      color: var(--vscode-textPreformat-foreground, #9cdcfe);
      padding: 1px 4px;
      border-radius: 3px;
    }

    .fixes-section {
      margin-bottom: 40px;
    }

    .fixes-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .fixes-list li {
      font-size: 12.5px;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background, #252526);
      border-left: 3px solid var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
      border-radius: 0 4px 4px 0;
    }

    .fix-title {
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .fix-desc {
      color: var(--vscode-descriptionForeground);
    }

    .footer {
      text-align: center;
      padding-top: 32px;
      border-top: 1px solid var(--vscode-sideBar-border, #3c3c3c);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .footer strong {
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div class="hero">
    <div class="hero-icon">⚡</div>
    <div class="hero-text">
      <div class="hero-title-row">
        <div class="hero-title">What's New in CDS Debug</div>
        <div class="version-badge">🚀 ${entry.label}</div>
      </div>
      <div class="hero-subtitle">Debug multiple SAP CAP services simultaneously — from VS Code.</div>
    </div>
  </div>

  <div class="content">
    <div class="section-title">What's New</div>
    <div class="features-grid">
      ${featuresHtml}
    </div>

    <div class="footer">
      <strong>Thank you for using CDS Debug!</strong><br/>
      Found a bug or have a feature request?
      Open an issue on <a href="https://github.com/dongitran/CDS-Debug/issues" style="color: var(--vscode-textLink-foreground);">GitHub</a>.
    </div>
  </div>
</body>
</html>`;
}
