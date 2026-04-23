export function getPackageBrowserStyles(): string {
  return `
    .packages-panel {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .packages-tree {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
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

    .packages-tree-branch,
    .packages-tree-children {
      display: flex;
      flex-direction: column;
    }

    .packages-tree-children {
      position: relative;
    }

    .packages-tree-row {
      width: 100%;
      min-height: 28px;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 8px;
      padding-left: calc(8px + (var(--packages-tree-level, 1) - 1) * 14px);
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      text-align: left;
      font-size: 12px;
    }

    .packages-tree-row:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .packages-tree-row:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
      border-color: var(--vscode-focusBorder);
    }

    .packages-tree-file-row.selected,
    .packages-tree-file-row[aria-selected="true"] {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-color: var(--vscode-focusBorder);
    }

    .packages-tree-package-row {
      font-weight: 600;
    }

    .packages-tree-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .packages-tree-badge {
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

    .packages-tree-disclosure {
      width: 10px;
      height: 10px;
      flex-shrink: 0;
      position: relative;
    }

    .packages-tree-disclosure::before {
      content: '';
      position: absolute;
      left: 1px;
      top: 1px;
      width: 0;
      height: 0;
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      border-left: 5px solid var(--vscode-descriptionForeground);
      transform-origin: 2px 4px;
      transition: transform 0.12s ease;
    }

    .packages-tree-disclosure.expanded::before {
      transform: rotate(90deg);
    }

    .packages-tree-disclosure.leaf::before {
      opacity: 0;
    }

    .packages-tree-icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      position: relative;
      opacity: 0.95;
      color: var(--vscode-symbolIcon-fileForeground, var(--vscode-descriptionForeground));
    }

    .packages-tree-icon-package {
      color: var(--vscode-symbolIcon-packageForeground, var(--vscode-descriptionForeground));
    }

    .packages-tree-icon-package::before {
      content: '';
      position: absolute;
      inset: 1px;
      border: 1px solid currentColor;
      border-radius: 3px;
      background: color-mix(in srgb, currentColor 14%, transparent);
    }

    .packages-tree-icon-package::after {
      content: '';
      position: absolute;
      left: 3px;
      right: 3px;
      top: 5px;
      height: 1px;
      background: currentColor;
      opacity: 0.55;
    }

    .packages-tree-icon-package.open::before {
      background: color-mix(in srgb, currentColor 18%, transparent);
    }

    .packages-tree-icon-folder {
      color: var(--vscode-symbolIcon-folderForeground, var(--vscode-textLink-foreground));
    }

    .packages-tree-icon-folder::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 3px;
      bottom: 1px;
      border: 1px solid currentColor;
      border-radius: 3px;
      background: color-mix(in srgb, currentColor 15%, transparent);
    }

    .packages-tree-icon-folder::after {
      content: '';
      position: absolute;
      left: 1px;
      top: 1px;
      width: 7px;
      height: 4px;
      border: 1px solid currentColor;
      border-bottom: none;
      border-radius: 3px 3px 0 0;
      background: color-mix(in srgb, currentColor 11%, transparent);
    }

    .packages-tree-icon-folder.open::before {
      background: color-mix(in srgb, currentColor 22%, transparent);
    }

    .packages-tree-icon-file::before {
      content: '';
      position: absolute;
      left: 1px;
      right: 2px;
      top: 1px;
      bottom: 1px;
      border: 1px solid currentColor;
      border-radius: 2px;
      background: color-mix(in srgb, currentColor 7%, transparent);
    }

    .packages-tree-icon-file::after {
      content: '';
      position: absolute;
      right: 2px;
      top: 1px;
      width: 5px;
      height: 5px;
      border-top: 1px solid currentColor;
      border-right: 1px solid currentColor;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      clip-path: polygon(0 0, 100% 0, 100% 100%);
    }

    .packages-error {
      margin-bottom: 8px;
    }
  `;
}
