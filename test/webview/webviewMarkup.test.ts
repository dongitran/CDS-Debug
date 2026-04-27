import { describe, expect, it } from 'vitest';

import { getPackageBrowserScriptContent } from '../../src/webview/packageBrowserContent';
import { getPackageBrowserStyles } from '../../src/webview/packageBrowserStyles';
import { getScript } from '../../src/webview/webviewScript';
import { getRendererScriptContent } from '../../src/webview/webviewRenderers';

interface WebviewRegion {
  readonly code: string;
  readonly name: string;
  readonly label: string;
  readonly apiEndpoint: string;
}

function isWebviewRegion(value: unknown): value is WebviewRegion {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === 'string'
    && typeof record.name === 'string'
    && typeof record.label === 'string'
    && typeof record.apiEndpoint === 'string';
}

function readInjectedRegions(script: string): WebviewRegion[] {
  const match = /const CF_REGIONS = ([\s\S]*?);\n/.exec(script);
  if (!match?.[1]) throw new Error('CF_REGIONS catalog was not injected');
  const parsed: unknown = JSON.parse(match[1]);
  if (!Array.isArray(parsed) || !parsed.every(isWebviewRegion)) {
    throw new Error('CF_REGIONS catalog has an unexpected shape');
  }
  return parsed;
}

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
    expect(rendererScript).toContain("renderSearchField('org-search-input'");
    expect(rendererScript).toContain("renderSearchField('region-search-input'");
    expect(rendererScript).toContain('search-input-icon');
    expect(rendererScript).toContain('region-selector-tabs');
    expect(rendererScript).toContain('class="region-list"');
    expect(rendererScript).toContain('role="radiogroup"');
    expect(rendererScript).toContain('data-region-selector-mode="org"');
    expect(rendererScript).toContain('data-region-selector-mode="region"');
    expect(rendererScript).toContain('class="org-search-row ${selected ?');
    expect(rendererScript).toContain('data-org-search-region');
    expect(rendererScript).toContain('aria-pressed="');
    expect(rendererScript).toContain('Continue with Selected Org');
    expect(rendererScript).toContain('CF Region / Org');
  });

  it('injects the complete sorted Cloud Foundry region catalog', () => {
    const regions = readInjectedRegions(getScript('test-nonce'));
    const sortedNames = regions.map((region) => region.name);

    expect(regions).toHaveLength(41);
    expect(sortedNames).toEqual([...sortedNames].sort((a, b) => a.localeCompare(b)));
    expect(regions[0]?.code).toBe('ap12');
    expect(regions.some((region) => region.code === 'ae01')).toBe(true);
    expect(regions.some((region) => region.code === 'sa31')).toBe(true);
    expect(regions.some((region) => region.code === 'uk20')).toBe(true);
    expect(regions.find((region) => region.code === 'cn20')?.apiEndpoint)
      .toBe('https://api.cf.cn20.platform.sapcloud.cn');
    expect(regions.find((region) => region.code === 'cn40')?.apiEndpoint)
      .toBe('https://api.cf.cn40.platform.sapcloud.cn');
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
