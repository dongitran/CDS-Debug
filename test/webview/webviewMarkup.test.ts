import { describe, expect, it } from 'vitest';

import { getPackageBrowserScriptContent } from '../../src/webview/packageBrowserContent';
import { getPackageBrowserStyles } from '../../src/webview/packageBrowserStyles';
import { getRendererScriptContent } from '../../src/webview/webviewRenderers';

describe('webview markup contracts', () => {
  it('keeps Package as the only active-session secondary action', () => {
    const rendererScript = getRendererScriptContent();

    expect(rendererScript).toContain('data-packages-app');
    expect(rendererScript).toContain('Package</button>');
    expect(rendererScript).not.toContain('Open App');
    expect(rendererScript).toContain('enableBreakpointSnapshotHandling');
    expect(rendererScript).toContain('Select CF Space');
    expect(rendererScript).toContain('name="cf-space"');
    expect(rendererScript).toContain('Space</span>');
    expect(rendererScript).toContain('Search org (across regions)');
    expect(rendererScript).toContain('id="org-search-input"');
    expect(rendererScript).toContain('<button class="org-search-row" type="button"');
    expect(rendererScript).toContain('data-org-search-region');
    expect(rendererScript).toContain('CF Region / Org');
  });

  it('keeps the package browser screen minimal', () => {
    const packageScript = getPackageBrowserScriptContent();

    expect(packageScript).not.toContain('<span class="step-title">Packages</span>');
    expect(packageScript).not.toContain('Browse loaded package sources for the current debug session and filter them before opening files.');
    expect(packageScript).not.toContain('packages-summary');
    expect(packageScript).not.toContain('packages-columns');
    expect(packageScript).not.toContain('packages-file-item');
    expect(packageScript).not.toContain('packages-tree-badge');
    expect(packageScript).toContain('packages-session-header');
    expect(packageScript).toContain('packages-session-heading');
    expect(packageScript).toContain('btn-packages-settings');
    expect(packageScript).toContain('renderPackageSettingsScreen');
    expect(packageScript).toContain('packages-filter-regex-input');
    expect(packageScript).toContain('<span>Reload</span>');
    expect(packageScript).not.toContain('<span>Refresh</span>');
    expect(packageScript).toContain('trimPackageDisplayLabel');
    expect(packageScript).toContain('packages-tree');
    expect(packageScript).toContain('data-tree-branch-id');
    expect(packageScript).toContain('packages-tree-package-row');
  });

  it('keeps package tree icons and header styling theme-aware', () => {
    const packageStyles = getPackageBrowserStyles();

    expect(packageStyles).toContain('.packages-session-header');
    expect(packageStyles).toContain('.packages-session-actions');
    expect(packageStyles).toContain('.packages-refresh-btn');
    expect(packageStyles).toContain('.packages-settings-btn');
    expect(packageStyles).toContain('.packages-tree-icon-package');
    expect(packageStyles).toContain('.packages-tree-icon-folder');
    expect(packageStyles).toContain('.packages-tree-icon-file');
    expect(packageStyles).toContain('--vscode-charts-orange');
    expect(packageStyles).toContain('--vscode-symbolIcon-folderForeground');
    expect(packageStyles).toContain('--vscode-symbolIcon-fileForeground');
    expect(packageStyles).not.toContain('.packages-tree-badge');
  });
});
