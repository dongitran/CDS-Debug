import { getPackageBrowserStyles } from './packageBrowserStyles';

/** CSS styles for the CDS Debug Launcher webview panel. */
export function getStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      overflow: hidden;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    #app {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      height: 100%;
      width: 100%;
    }

    /* Wrapper for the READY screen — fills remaining height as a flex column */
    .ready-layout {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      height: 100%;
    }

    h2 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
    }

    .section-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin: 14px 0 6px;
    }

    /* ── Buttons ── */
    .btn {
      display: block;
      width: 100%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 7px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      text-align: center;
      font-weight: 500;
      transition: background 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.18);
    }
    .btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
      box-shadow: 0 3px 7px rgba(0,0,0,0.22);
    }
    .btn:active:not(:disabled) {
      transform: translateY(0);
      box-shadow: 0 1px 2px rgba(0,0,0,0.12);
    }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      box-shadow: none;
    }
    .btn-secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
      box-shadow: 0 2px 5px rgba(0,0,0,0.14);
    }

    /* ── Input ── */
    .input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      outline: none;
      transition: border-color 0.18s, box-shadow 0.18s;
    }
    .input:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }

    /* ── Select ── */
    .select {
      width: 100%;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
    }

    /* ── Radio group ── */
    .radio-group { display: flex; flex-direction: column; gap: 6px; }
    .radio-item {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
      transition: border-color 0.15s, background 0.15s;
    }
    .radio-item:hover { background: var(--vscode-list-hoverBackground); }
    .radio-item input[type=radio] { cursor: pointer; }
    .radio-desc { font-size: 11px; color: var(--vscode-descriptionForeground); }

    /* ── Region layout ── */
    .region-layout {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .region-tab-panel {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .region-layout > .btn {
      flex-shrink: 0;
    }

    /* ── Region selector tabs ── */
    .region-selector-tabs {
      display: flex;
      gap: 4px;
      padding: 3px;
      margin-bottom: 10px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 6px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    .selector-tab {
      flex: 1;
      border: none;
      border-radius: 4px;
      padding: 5px 8px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      transition: color 0.15s, background 0.15s, font-weight 0.15s;
    }
    .selector-tab:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }
    .selector-tab.active {
      color: var(--vscode-list-activeSelectionForeground);
      background: var(--vscode-list-activeSelectionBackground);
      font-weight: 600;
    }

    /* ── Search input ── */
    .search-input-wrap {
      position: relative;
      width: 100%;
    }
    .search-input {
      padding-left: 28px;
    }
    .search-input-icon {
      position: absolute;
      left: 9px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--vscode-descriptionForeground);
      width: 14px;
      height: 14px;
      pointer-events: none;
      opacity: 0.9;
    }
    .search-input-icon svg {
      display: block;
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    /* ── Region list ── */
    .region-list {
      display: flex;
      flex-direction: column;
      gap: 0;
      margin-bottom: 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      overflow-y: auto;
      background: var(--vscode-editor-background);
    }
    .region-tab-panel .region-list {
      flex: 1;
      min-height: 120px;
    }
    .region-card {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 7px 8px;
      border-bottom: 1px solid var(--vscode-input-border, transparent);
      cursor: pointer;
      transition: border-color 0.1s, background 0.1s;
      min-width: 0;
    }
    .region-card:hover { background: var(--vscode-list-hoverBackground); }
    .region-card:last-child { border-bottom: none; }
    .region-card.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
    }
    .region-card input[type=radio] {
      position: absolute;
      opacity: 0;
      width: 1px;
      height: 1px;
    }
    .region-card-content {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }
    .region-main {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
    }
    .region-code {
      flex: 0 0 42px;
      font-size: 12px;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family);
      text-transform: uppercase;
    }
    .custom-region-code {
      font-size: 11px;
      text-transform: none;
    }
    .region-name {
      min-width: 0;
      font-size: 12px;
      color: var(--vscode-foreground);
      overflow-wrap: anywhere;
    }
    .region-endpoint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    .region-card.selected .region-name { color: inherit; opacity: 0.8; }
    .region-card.selected .region-endpoint { color: inherit; opacity: 0.7; }

    .region-search-block {
      margin-bottom: 8px;
    }

    .region-list-empty {
      padding: 10px 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
    }

    /* ── Cross-region org search ── */
    .org-search-block {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
      min-height: 0;
      margin-bottom: 8px;
    }
    .org-search-results {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      background: var(--vscode-input-background);
    }
    .org-search-results.empty {
      padding: 8px 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-align: center;
    }
    .org-search-results.empty {
      flex: 0 0 auto;
    }
    .org-search-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      transition: background 0.1s;
      border-radius: 0;
      border: 0;
      width: 100%;
      color: var(--vscode-foreground);
      background: transparent;
      font: inherit;
      text-align: left;
    }
    .org-search-row:hover { background: var(--vscode-list-hoverBackground); }
    .org-search-row.selected {
      color: var(--vscode-list-activeSelectionForeground);
      background: var(--vscode-list-activeSelectionBackground);
    }
    .org-search-row.selected .org-search-meta {
      color: inherit;
      opacity: 0.82;
    }
    .org-search-row:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .org-search-org {
      font-size: 12px;
      font-family: var(--vscode-editor-font-family);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .org-search-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    /* ── App list ── */
    /* flex:1 + min-height:0 lets it fill whatever space .ready-layout has left */
    .app-list { display: flex; flex-direction: column; gap: 2px; flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
    .app-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 6px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.12s;
      position: relative;
    }
    .app-row:hover:not(.stopped):not(.in-debug) { background: var(--vscode-list-hoverBackground); }
    .app-row.stopped { opacity: 0.5; cursor: not-allowed; }
    .app-row.in-debug { cursor: default; opacity: 0.75; }
    .app-name {
      flex: 1;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Status badges ── */
    .badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 99px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .badge-started {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 14%, transparent);
      border: 1px solid var(--vscode-testing-iconPassed);
      color: var(--vscode-testing-iconPassed);
    }
    .badge-stopped {
      background: transparent;
      border: 1px solid var(--vscode-descriptionForeground);
      color: var(--vscode-descriptionForeground);
    }
    .badge-debug {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .divider { height: 1px; background: var(--vscode-panel-border); margin: 12px 0; }

    /* ── CF info box ── */
    .cf-info-box {
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px 10px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .cf-info-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 2px 0;
    }
    .cf-info-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      min-width: 44px;
      flex-shrink: 0;
    }
    .cf-info-value {
      font-size: 12px;
      font-family: var(--vscode-editor-font-family);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Info / error / warning boxes ── */
    .info-box {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      padding: 8px 10px;
      border-radius: 0 4px 4px 0;
      font-size: 12px;
      margin-bottom: 10px;
    }

    .error-box {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 12px;
      margin-bottom: 10px;
    }

    .warning-box {
      background: var(--vscode-inputValidation-warningBackground, rgba(204,153,0,0.1));
      border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.5;
      margin-bottom: 10px;
    }
    .warning-box code {
      font-family: var(--vscode-editor-font-family);
      font-size: 10.5px;
      background: var(--vscode-textCodeBlock-background);
      padding: 0 3px;
      border-radius: 2px;
    }

    /* ── Spinner ── */
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 0.7s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Step header ── */
    .step-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .ready-step-header {
      margin-bottom: 8px;
    }
    .step-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 99px;
      letter-spacing: 0.02em;
      box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    }
    .step-title { font-size: 13px; font-weight: 600; flex: 1 1 120px; min-width: 0; }

    /* ── Header nav button ── */
    .header-nav-btn {
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 4px;
      font-size: 10px;
      line-height: 1.3;
      padding: 3px 7px;
      cursor: pointer;
      max-width: 170px;
      text-overflow: ellipsis;
      overflow: hidden;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.15s, border-color 0.15s;
    }
    .header-nav-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    /* ── Gear button ── */
    .gear-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      font-size: 15px;
      line-height: 1;
      padding: 0 2px;
      cursor: pointer;
      transition: color 0.18s;
    }
    .gear-btn:hover { color: var(--vscode-foreground); }

    /* ── Sync status row ── */
    .sync-status-row {
      display: flex;
      align-items: center;
      font-size: 12px;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
    }
    .sync-status-row.running {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    /* ── Org / space lists ── */
    .org-list,
    .space-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 240px;
      overflow-y: auto;
      padding-right: 2px;
    }
    .org-item,
    .space-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
    }
    .org-item:hover,
    .space-item:hover { background: var(--vscode-list-hoverBackground); }
    .org-item.selected,
    .space-item.selected {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
    }
    .org-item input[type=radio],
    .space-item input[type=radio] {
      position: absolute;
      opacity: 0;
      width: 1px;
      height: 1px;
      pointer-events: none;
    }
    .org-item-name,
    .space-item-name {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .org-list-empty {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      padding: 8px 4px;
    }

    /* ── Active session card ── */
    .active-card {
      display: flex;
      align-items: center;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-focusBorder);
      border-radius: 6px;
      padding: 8px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.12);
      animation: slideIn 0.25s ease;
      transition: border-left-color 0.2s, box-shadow 0.2s;
    }
    /* Status-specific left border accent */
    .active-card[data-status="attached"] {
      border-left-color: var(--vscode-testing-iconPassed);
    }
    .active-card[data-status="error"] {
      border-left-color: var(--vscode-testing-iconFailed);
    }
    .active-card[data-status="tunneling"],
    .active-card[data-status="pending"],
    .active-card[data-status="ssh_enabling"],
    .active-card[data-status="ssh_restarting"] {
      border-left-color: var(--vscode-focusBorder);
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-5px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .active-card-main { flex: 1; min-width: 0; }
    .active-card-title {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 4px;
    }
    .active-card-status {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
    }
    .active-card-status > span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── Active card action buttons ── */
    .active-stop-btn {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      margin-left: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--vscode-testing-iconFailed);
      color: var(--vscode-testing-iconFailed);
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    }
    .active-stop-btn:hover {
      background: var(--vscode-testing-iconFailed);
      color: white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.22);
    }
    .active-packages-btn {
      flex-shrink: 0;
      height: 26px;
      padding: 0 8px;
      margin-left: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .active-packages-btn:hover {
      background: var(--vscode-button-hoverBackground);
      box-shadow: 0 2px 5px rgba(0,0,0,0.18);
    }
    .active-retry-btn {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      margin-left: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--vscode-focusBorder);
      color: var(--vscode-focusBorder);
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    }
    .active-retry-btn:hover {
      background: var(--vscode-focusBorder);
      color: white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.22);
    }
    .status-text-anim {
      display: inline-block;
      animation: fadeIn 0.4s;
    }
    @keyframes fadeIn { from { opacity: 0.3; } to { opacity: 1; } }

    /* ── Footer ── */
    /* Footer is a natural flex item at the end of .ready-layout — no sticky needed */
    .footer {
      flex-shrink: 0;
      padding: 10px 0 0;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 10px;
    }
    .footer-info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      text-align: center;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .active-card-port {
      font-size: 10px;
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
      margin-left: 4px;
    }

    .active-card-no-src {
      display: inline-block;
      font-size: 9px;
      font-weight: 500;
      font-family: var(--vscode-font-family);
      color: var(--vscode-inputValidation-warningForeground, #cc9b00);
      background: var(--vscode-inputValidation-warningBackground, rgba(204, 153, 0, 0.1));
      border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      border-radius: 3px;
      padding: 0 3px;
      margin-left: 5px;
      vertical-align: middle;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* ── Select-all row ── */
    .select-all-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      margin-bottom: 4px;
      cursor: pointer;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-radius: 4px;
      transition: background 0.12s, color 0.12s;
    }
    .select-all-row:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .select-all-row input[type=checkbox] { cursor: pointer; }

    /* ── Stop all button ── */
    .stop-all-btn {
      display: block;
      width: 100%;
      padding: 4px 8px;
      margin-bottom: 6px;
      background: transparent;
      border: 1px solid var(--vscode-testing-iconFailed);
      color: var(--vscode-testing-iconFailed);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-family: var(--vscode-font-family);
      text-align: center;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .stop-all-btn:hover {
      background: var(--vscode-testing-iconFailed);
      color: white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
    }

    /* ── Breakpoint snapshots panel ── */
    .bp-panel {
      margin-bottom: 10px;
    }
    .bp-panel-screen {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      margin-bottom: 12px;
    }
    .bp-panel-screen .bp-grid {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .bp-panel-screen .bp-list {
      flex: 1;
      min-height: 120px;
      max-height: none;
    }
    .bp-panel-screen .bp-detail {
      max-height: 240px;
    }
    .bp-section-label {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 0;
      margin-bottom: 6px;
    }
    .bp-count {
      font-size: 10px;
      padding: 0 6px;
      border-radius: 99px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-weight: 700;
    }
    .bp-clear-btn {
      margin-left: auto;
      border: 1px solid var(--vscode-input-border, transparent);
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 4px;
      font-size: 10px;
      padding: 2px 6px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .bp-clear-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
    }
    .bp-clear-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .bp-back-btn {
      border: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }
    .bp-back-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .bp-empty {
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .bp-grid {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    .bp-list {
      display: flex;
      flex-direction: column;
      max-height: 140px;
      overflow-y: auto;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .bp-item {
      width: 100%;
      text-align: left;
      border: none;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: transparent;
      padding: 6px 8px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
      transition: background 0.1s;
    }
    .bp-item:last-child {
      border-bottom: none;
    }
    .bp-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .bp-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
    }
    .bp-item-top {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .bp-item-app {
      flex: 1;
      font-size: 11px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
    }
    .bp-item-mode {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-radius: 99px;
      padding: 1px 6px;
      border: 1px solid transparent;
      flex-shrink: 0;
    }
    .mode-auto {
      color: var(--vscode-testing-iconPassed);
      border-color: var(--vscode-testing-iconPassed);
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, transparent);
    }
    .mode-paused {
      color: var(--vscode-inputValidation-warningForeground, #cc9b00);
      border-color: var(--vscode-inputValidation-warningBorder, #cca700);
      background: var(--vscode-inputValidation-warningBackground, rgba(204,153,0,0.1));
    }
    .bp-item-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bp-item.selected .bp-item-meta {
      color: inherit;
      opacity: 0.85;
    }
    .bp-detail-wrap {
      padding: 8px;
      background: var(--vscode-editor-background);
    }
    .bp-detail-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .bp-detail {
      margin: 0;
      max-height: 170px;
      overflow: auto;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 11px;
      line-height: 1.45;
      font-family: var(--vscode-editor-font-family);
      white-space: pre;
    }

    /* ── Progress bar ── */
    .progress-bar-wrap {
      height: 4px;
      background: var(--vscode-progressBar-background, var(--vscode-panel-border));
      border-radius: 2px;
      overflow: hidden;
      margin: 6px 0 4px;
      opacity: 0.5;
    }
    .progress-bar-fill {
      height: 100%;
      background: var(--vscode-button-background);
      border-radius: 2px;
      transition: width 0.4s ease;
    }

    /* ── Debug preferences toggle row ── */
    .pref-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 8px 0;
      cursor: pointer;
    }
    .pref-row-content { flex: 1; min-width: 0; }
    .pref-row-title {
      display: block;
      font-size: 13px;
      margin-bottom: 3px;
    }
    .beta-badge {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 1px 5px;
      border-radius: 99px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      vertical-align: middle;
      margin-left: 4px;
    }
    .pref-state-badge {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 1px 6px;
      border-radius: 99px;
      vertical-align: middle;
      margin-left: 6px;
    }
    .pref-state-off {
      background: transparent;
      border: 1px solid var(--vscode-descriptionForeground);
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
    }
    .pref-state-on {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent);
      border: 1px solid var(--vscode-testing-iconPassed);
      color: var(--vscode-testing-iconPassed);
    }
    .pref-row-desc {
      display: block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    /* ── Toggle switch ── */
    .toggle-switch {
      flex-shrink: 0;
      position: relative;
      width: 32px;
      height: 18px;
      margin-top: 2px;
      cursor: pointer;
    }
    .toggle-switch input[type=checkbox] {
      position: absolute;
      opacity: 0;
      width: 1px;
      height: 1px;
      pointer-events: none;
    }
    .toggle-track {
      display: block;
      width: 32px;
      height: 18px;
      border-radius: 9px;
      background: var(--vscode-input-border, rgba(128,128,128,0.4));
      transition: background 0.22s ease;
      position: relative;
    }
    .toggle-switch.on .toggle-track {
      background: var(--vscode-button-background);
    }
    .toggle-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: white;
      transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 1px 4px rgba(0,0,0,0.35);
    }
    .toggle-switch.on .toggle-thumb {
      transform: translateX(14px);
    }

    /* ── VSCode note box ── */
    .vscode-note-box {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-editorInfo-foreground, var(--vscode-focusBorder));
      border-radius: 0 4px 4px 0;
      padding: 8px 10px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    .vscode-note-box code {
      font-family: var(--vscode-editor-font-family);
      font-size: 10.5px;
      background: var(--vscode-textCodeBlock-background);
      padding: 0 3px;
      border-radius: 2px;
    }
    .vscode-note-icon {
      flex-shrink: 0;
      font-size: 13px;
      line-height: 1.4;
      color: var(--vscode-editorInfo-foreground, var(--vscode-focusBorder));
    }

    /* ── Branch preparation screen ── */
    .prep-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .prep-row {
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px 10px;
      animation: slideIn 0.25s ease;
      transition: border-color 0.2s;
    }
    .prep-row-top {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 5px;
    }
    .prep-name {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      font-weight: 600;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .branch-badge {
      display: inline-flex;
      align-items: center;
      font-size: 10px;
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 7px 1px 5px;
      border-radius: 99px;
      flex-shrink: 0;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .prep-row-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-height: 16px;
    }
    .prep-icon {
      font-size: 12px;
      flex-shrink: 0;
      line-height: 1;
    }
    .prep-icon-ok  { color: var(--vscode-testing-iconPassed); }
    .prep-icon-skip { color: var(--vscode-descriptionForeground); }
    .prep-icon-err { color: var(--vscode-testing-iconFailed); }
    .prep-status-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Credential setup screen ── */
    .input-password-wrap {
      position: relative;
    }
    .input-password-wrap .input {
      padding-right: 34px;
    }
    .btn-toggle-visibility {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 2px;
      transition: color 0.15s;
    }
    .btn-toggle-visibility:hover { color: var(--vscode-foreground); }

    /* ── Credential source badge ── */
    .cred-source-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 99px;
      letter-spacing: 0.03em;
    }
    .cred-source-badge.env {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent);
      border: 1px solid var(--vscode-testing-iconPassed);
      color: var(--vscode-testing-iconPassed);
    }
    .cred-source-badge.keychain {
      background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
      border: 1px solid var(--vscode-focusBorder);
      color: var(--vscode-focusBorder);
    }
    .cred-source-badge.none {
      background: transparent;
      border: 1px solid var(--vscode-descriptionForeground);
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
    }

    /* ── Credential info row ── */
    .cred-info-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: 12px;
    }
    .cred-info-email {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Credential info icon with tooltip ── */
    .cred-info-icon {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-descriptionForeground);
      border-radius: 50%;
      cursor: help;
      line-height: 1;
      transition: color 0.15s, border-color 0.15s;
    }
    .cred-info-icon:hover,
    .cred-info-icon:focus {
      color: var(--vscode-foreground);
      border-color: var(--vscode-foreground);
    }
    .cred-info-tooltip {
      display: none;
      position: absolute;
      top: calc(100% + 6px);
      right: -4px;
      width: 220px;
      padding: 8px 10px;
      border-radius: 4px;
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      font-size: 11px;
      font-weight: 400;
      line-height: 1.45;
      white-space: normal;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      pointer-events: none;
    }
    .cred-info-icon:hover .cred-info-tooltip,
    .cred-info-icon:focus .cred-info-tooltip {
      display: block;
    }

    /* ── Credential button row ── */
    .cred-btn-row {
      display: flex;
      gap: 6px;
    }
    .cred-btn-row .btn,
    .cred-btn-row .btn-secondary {
      flex: 1;
      font-size: 12px;
      padding: 5px 6px;
    }

    /* ── Credential env hint ── */
    .cred-env-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      line-height: 1.5;
    }
    .cred-env-hint code {
      font-family: var(--vscode-editor-font-family);
      font-size: 10.5px;
      background: var(--vscode-textCodeBlock-background);
      padding: 0 3px;
      border-radius: 2px;
    }

    ${getPackageBrowserStyles()}
  `;
}
