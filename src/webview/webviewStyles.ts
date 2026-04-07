/** CSS styles for the CDS Debug Launcher webview panel. */
export function getStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      min-height: 100vh;
      overflow-x: hidden;
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
      transition: background 0.2s;
    }
    .btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }

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
      transition: border-color 0.2s;
    }
    .input:focus { border-color: var(--vscode-focusBorder); }

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

    .radio-group { display: flex; flex-direction: column; gap: 6px; }
    .radio-item {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
    }
    .radio-item:hover { background: var(--vscode-list-hoverBackground); }
    .radio-item input[type=radio] { cursor: pointer; }
    .radio-desc { font-size: 11px; color: var(--vscode-descriptionForeground); }

    .region-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-bottom: 8px;
    }
    .region-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 8px 6px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
      cursor: pointer;
      text-align: center;
      transition: border-color 0.1s, background 0.1s;
    }
    .region-card:hover { background: var(--vscode-list-hoverBackground); }
    .region-card.selected {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .region-card input[type=radio] {
      position: absolute;
      opacity: 0;
      width: 1px;
      height: 1px;
      pointer-events: none;
    }
    .region-code { font-size: 13px; font-weight: 700; font-family: var(--vscode-editor-font-family); }
    .region-name { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .region-card.selected .region-name { color: inherit; opacity: 0.8; }
    .region-card-custom {
      grid-column: 1 / -1;
    }

    .app-list { display: flex; flex-direction: column; gap: 2px; max-height: calc(100vh - 320px); min-height: 120px; overflow-y: auto; padding-right: 2px; }
    .app-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 6px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.1s;
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
    .badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 99px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .badge-started {
      background: transparent;
      border: 1px solid var(--vscode-testing-iconPassed);
      color: var(--vscode-testing-iconPassed);
    }
    .badge-stopped {
      background: transparent;
      border: 1px solid var(--vscode-descriptionForeground);
      color: var(--vscode-descriptionForeground);
    }
    .badge-debug { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

    .divider { height: 1px; background: var(--vscode-panel-border); margin: 12px 0; }

    .cf-info-box {
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
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

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .step-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
    }
    .step-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 99px;
    }
    .step-title { font-size: 13px; font-weight: 600; flex: 1; }
    .gear-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      font-size: 15px;
      line-height: 1;
      padding: 0 2px;
      cursor: pointer;
      transition: color 0.2s;
    }
    .gear-btn:hover { color: var(--vscode-foreground); }

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

    .org-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 240px;
      overflow-y: auto;
      padding-right: 2px;
    }
    .org-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
      cursor: pointer;
      transition: border-color 0.1s, background 0.1s;
    }
    .org-item:hover { background: var(--vscode-list-hoverBackground); }
    .org-item.selected {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .org-item input[type=radio] {
      position: absolute;
      opacity: 0;
      width: 1px;
      height: 1px;
      pointer-events: none;
    }
    .org-item-name {
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

    .active-card {
      display: flex;
      align-items: center;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      animation: slideIn 0.3s ease;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-4px); }
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
      transition: all 0.2s;
    }
    .active-stop-btn:hover {
      background: var(--vscode-testing-iconFailed);
      color: white;
    }
    .active-open-btn {
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
      transition: background 0.2s;
    }
    .active-open-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .status-text-anim {
      display: inline-block;
      animation: fadeIn 0.4s;
    }
    @keyframes fadeIn { from { opacity: 0.3; } to { opacity: 1; } }

    .footer {
      position: sticky;
      bottom: 0;
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
    }
    .select-all-row:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .select-all-row input[type=checkbox] { cursor: pointer; }

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
      transition: all 0.2s;
    }
    .stop-all-btn:hover {
      background: var(--vscode-testing-iconFailed);
      color: white;
    }

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

    @media (max-width: 260px) {
      .region-grid { grid-template-columns: 1fr; }
      .region-card-custom { grid-column: 1; }
    }

    /* Debug preferences toggle row */
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
    .pref-row-desc {
      display: block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }
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
      transition: background 0.2s;
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
      transition: transform 0.2s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .toggle-switch.on .toggle-thumb {
      transform: translateX(14px);
    }

    /* Branch preparation screen */
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
  `;
}
