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
      color: var(--vscode-foreground);
    }

    .packages-tree-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
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
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      position: relative;
      opacity: 0.98;
      color: var(--vscode-symbolIcon-fileForeground, var(--vscode-textLink-foreground));
    }

    .packages-tree-icon-package {
      color: var(--vscode-charts-orange, var(--vscode-symbolIcon-packageForeground, #cd861a));
    }

    .packages-tree-icon-package::before {
      content: '';
      position: absolute;
      inset: 2px 1px 1px;
      border: 1px solid color-mix(in srgb, currentColor 72%, var(--vscode-editor-background));
      border-radius: 4px;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, currentColor 42%, var(--vscode-editor-background)) 0%,
        color-mix(in srgb, currentColor 26%, var(--vscode-editor-background)) 100%
      );
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 28%, transparent);
    }

    .packages-tree-icon-package::after {
      content: '';
      position: absolute;
      left: 4px;
      right: 4px;
      top: 6px;
      height: 2px;
      border-radius: 999px;
      background: color-mix(in srgb, currentColor 84%, white);
      opacity: 0.82;
    }

    .packages-tree-icon-package.open::before {
      background: linear-gradient(
        180deg,
        color-mix(in srgb, currentColor 48%, var(--vscode-editor-background)) 0%,
        color-mix(in srgb, currentColor 31%, var(--vscode-editor-background)) 100%
      );
    }

    .packages-tree-icon-folder {
      color: var(--vscode-symbolIcon-folderForeground, var(--vscode-charts-yellow, #d7ba7d));
    }

    .packages-tree-icon-folder::before {
      content: '';
      position: absolute;
      left: 1px;
      right: 0;
      top: 4px;
      bottom: 1px;
      border: 1px solid color-mix(in srgb, currentColor 68%, var(--vscode-editor-background));
      border-radius: 4px;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, currentColor 46%, var(--vscode-editor-background)) 0%,
        color-mix(in srgb, currentColor 27%, var(--vscode-editor-background)) 100%
      );
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 24%, transparent);
    }

    .packages-tree-icon-folder::after {
      content: '';
      position: absolute;
      left: 2px;
      top: 1px;
      width: 7px;
      height: 5px;
      border: 1px solid color-mix(in srgb, currentColor 68%, var(--vscode-editor-background));
      border-bottom: none;
      border-radius: 4px 4px 0 0;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, currentColor 56%, var(--vscode-editor-background)) 0%,
        color-mix(in srgb, currentColor 36%, var(--vscode-editor-background)) 100%
      );
    }

    .packages-tree-icon-folder.open::before {
      background: linear-gradient(
        180deg,
        color-mix(in srgb, currentColor 58%, var(--vscode-editor-background)) 0%,
        color-mix(in srgb, currentColor 36%, var(--vscode-editor-background)) 100%
      );
    }

    .packages-tree-icon-file {
      color: var(--vscode-symbolIcon-fileForeground, var(--vscode-textLink-foreground, #75beff));
    }

    .packages-tree-icon-file::before {
      content: '';
      position: absolute;
      left: 2px;
      right: 2px;
      top: 1px;
      bottom: 1px;
      border: 1px solid color-mix(in srgb, currentColor 64%, var(--vscode-editor-background));
      border-radius: 4px;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, currentColor 28%, var(--vscode-editor-background)) 0%,
        color-mix(in srgb, currentColor 16%, var(--vscode-editor-background)) 100%
      );
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 26%, transparent);
    }

    .packages-tree-icon-file::after {
      content: '';
      position: absolute;
      right: 2px;
      top: 1px;
      width: 5px;
      height: 5px;
      border-top: 1px solid color-mix(in srgb, currentColor 64%, var(--vscode-editor-background));
      border-right: 1px solid color-mix(in srgb, currentColor 64%, var(--vscode-editor-background));
      background: color-mix(in srgb, white 66%, currentColor);
      clip-path: polygon(0 0, 100% 0, 100% 100%);
    }

    .packages-error {
      margin-bottom: 8px;
    }

    .packages-session-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }

    .packages-session-heading {
      margin: 0;
      flex: 1;
      min-width: 0;
    }

    .packages-refresh-btn {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-width: 84px;
      padding: 5px 9px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 11px;
      line-height: 1;
    }

    .packages-refresh-btn:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .packages-refresh-btn:disabled {
      opacity: 0.72;
      cursor: default;
    }

    .packages-refresh-spinner {
      width: 11px;
      height: 11px;
      margin-right: 0;
      border-width: 1.5px;
    }
  `;
}
