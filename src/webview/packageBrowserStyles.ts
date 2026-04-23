export function getPackageBrowserStyles(): string {
  return `
    .packages-panel {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .packages-loading,
    .packages-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 96px;
      padding: 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      color: var(--vscode-descriptionForeground);
      text-align: center;
      font-size: 12px;
    }

    .packages-loading {
      gap: 8px;
    }

    .packages-columns {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
      flex: 1;
    }

    .packages-section {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .packages-section-label {
      margin-top: 0;
      margin-bottom: 6px;
    }

    .packages-list,
    .packages-files {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 0;
      max-height: 180px;
      overflow-y: auto;
      padding-right: 2px;
    }

    .packages-package-item,
    .packages-file-item {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-editorGroupHeader-tabsBackground);
      color: var(--vscode-foreground);
      cursor: pointer;
      text-align: left;
    }

    .packages-package-item:hover,
    .packages-file-item:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .packages-package-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-color: var(--vscode-focusBorder);
    }

    .packages-package-name,
    .packages-file-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .packages-package-count {
      flex-shrink: 0;
      min-width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 99px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px;
      font-weight: 700;
    }

    .packages-files-empty {
      min-height: 72px;
    }

    .packages-error {
      margin-bottom: 8px;
    }
  `;
}
