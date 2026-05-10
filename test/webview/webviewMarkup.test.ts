import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { getAllRegions } from '@saptools/cf-sync';

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

const UPSTREAM_CF_SYNC_REGION_CASES = [
  {
    code: 'eu10-002',
    name: 'Europe (Frankfurt) - AWS',
    label: 'Europe (Frankfurt) - AWS (eu10-002)',
    apiEndpoint: 'https://api.cf.eu10-002.hana.ondemand.com',
  },
  {
    code: 'eu10-003',
    name: 'Europe (Frankfurt) - AWS',
    label: 'Europe (Frankfurt) - AWS (eu10-003)',
    apiEndpoint: 'https://api.cf.eu10-003.hana.ondemand.com',
  },
  {
    code: 'eu10-004',
    name: 'Europe (Frankfurt) - AWS',
    label: 'Europe (Frankfurt) - AWS (eu10-004)',
    apiEndpoint: 'https://api.cf.eu10-004.hana.ondemand.com',
  },
  {
    code: 'eu10-005',
    name: 'Europe (Frankfurt) - AWS',
    label: 'Europe (Frankfurt) - AWS (eu10-005)',
    apiEndpoint: 'https://api.cf.eu10-005.hana.ondemand.com',
  },
  {
    code: 'eu20-001',
    name: 'Europe (Netherlands) - Azure',
    label: 'Europe (Netherlands) - Azure (eu20-001)',
    apiEndpoint: 'https://api.cf.eu20-001.hana.ondemand.com',
  },
  {
    code: 'eu20-002',
    name: 'Europe (Netherlands) - Azure',
    label: 'Europe (Netherlands) - Azure (eu20-002)',
    apiEndpoint: 'https://api.cf.eu20-002.hana.ondemand.com',
  },
  {
    code: 'us10-001',
    name: 'US East (VA) - AWS',
    label: 'US East (VA) - AWS (us10-001)',
    apiEndpoint: 'https://api.cf.us10-001.hana.ondemand.com',
  },
  {
    code: 'us10-002',
    name: 'US East (VA) - AWS',
    label: 'US East (VA) - AWS (us10-002)',
    apiEndpoint: 'https://api.cf.us10-002.hana.ondemand.com',
  },
] as const satisfies readonly WebviewRegion[];

const LOCAL_WEBVIEW_FALLBACK_REGION_CASES = [
  {
    code: 'us10-004',
    name: 'US East (VA) - AWS',
    label: 'US East (VA) - AWS (us10-004)',
    apiEndpoint: 'https://api.cf.us10-004.hana.ondemand.com',
  },
] as const satisfies readonly WebviewRegion[];

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

interface PostedMessage {
  readonly type: string;
  readonly payload?: unknown;
}

type MessageHandler = (event: { data: unknown }) => void;

interface RenderSettingsOptions {
  readonly syncStatus: {
    readonly isRunning: boolean;
    readonly startedAt?: number;
    readonly lastCompletedAt?: number;
    readonly lastAttemptedAt?: number;
    readonly lastSkipReason?: string;
    readonly done: number;
    readonly total: number;
    readonly currentRegion?: string;
    readonly currentOrg?: string;
  };
  readonly cacheConfig: {
    readonly enabled: boolean;
    readonly intervalHours: number;
  };
}

interface RendererContext {
  readonly state: Record<string, unknown>;
  readonly escape: (value: unknown) => string;
  renderSettings?: () => string;
}

function extractInlineScript(script: string): string {
  const match = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(script);
  if (!match?.[1]) throw new Error('Inline webview script was not found');
  return match[1];
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSettingsHtml(options: RenderSettingsOptions): string {
  const context: RendererContext = {
    state: {
      syncStatus: options.syncStatus,
      cacheConfig: options.cacheConfig,
      credentialStatus: {
        hasCredentials: false,
        email: '',
        source: 'none',
      },
      debugPrefs: {
        openBrowserOnAttach: false,
        enableBreakpointSnapshotHandling: false,
        enableBranchPrep: false,
      },
    },
    escape: escapeHtml,
  };
  vm.runInNewContext(getRendererScriptContent(), context, { timeout: 1000 });
  if (typeof context.renderSettings !== 'function') {
    throw new Error('renderSettings was not registered');
  }
  return context.renderSettings();
}

function createWebviewScriptHarness(): {
  readonly postedMessages: PostedMessage[];
  readonly dispatch: (message: PostedMessage) => void;
  readonly getHtml: () => string;
} {
  const postedMessages: PostedMessage[] = [];
  let messageHandler: MessageHandler | undefined;
  const appElement = { innerHTML: '' };
  const documentMock = {
    body: {},
    getElementById: (id: string): typeof appElement | null => (id === 'app' ? appElement : null),
    querySelector: (): null => null,
    querySelectorAll: (): unknown[] => [],
  };
  const windowMock = {
    addEventListener: (type: string, handler: unknown): void => {
      if (type === 'message') {
        messageHandler = handler as MessageHandler;
      }
    },
  };
  const context = {
    acquireVsCodeApi: () => ({
      postMessage: (message: PostedMessage): void => {
        postedMessages.push(message);
      },
    }),
    clearInterval,
    document: documentMock,
    setInterval,
    window: windowMock,
  };

  vm.runInNewContext(extractInlineScript(getScript('test-nonce')), context, { timeout: 1000 });
  if (!messageHandler) throw new Error('Webview message handler was not registered');
  postedMessages.length = 0;

  return {
    postedMessages,
    dispatch: (message: PostedMessage): void => {
      messageHandler?.({ data: message });
    },
    getHtml: (): string => appElement.innerHTML,
  };
}

function moveHarnessToReadyScreen(
  harness: ReturnType<typeof createWebviewScriptHarness>,
  orgName = 'sample-org-alpha',
  spaceName = 'app',
): void {
  harness.dispatch({
    type: 'CONFIG_LOADED',
    payload: {
      config: {
        apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
        orgs: ['sample-org-alpha', 'sample-org-beta'],
        orgGroupMappings: [{
          cfOrg: orgName,
          cfSpace: spaceName,
          groupFolderPath: '/tmp/sample-folder',
        }],
      },
      activeSessions: {},
      credentialStatus: {
        hasCredentials: true,
        email: 'sample.user@example.com',
        source: 'env',
      },
    },
  });
  harness.dispatch({
    type: 'APPS_LOADED',
    payload: { apps: [] },
  });
  harness.postedMessages.length = 0;
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
    expect(rendererScript).toContain('id="btn-custom-endpoint"');
    expect(rendererScript).toContain('id="api-endpoint-custom"');
    expect(rendererScript).toContain('id="btn-region-list"');
    expect(rendererScript).toContain('Region (Custom)');
    expect(rendererScript).toContain('data-region-selector-mode="org"');
    expect(rendererScript).toContain('data-region-selector-mode="region"');
    expect(rendererScript).toContain('class="org-search-row ${selected ?');
    expect(rendererScript).toContain('data-org-search-region');
    expect(rendererScript).toContain('aria-pressed="');
    expect(rendererScript).toContain('Continue with Selected Org');
    expect(rendererScript).toContain('CF Region / Org');
    expect(rendererScript).not.toContain('region-card-custom');
  });

  it('receives supplemental Cloud Foundry regions from cf-sync', () => {
    const upstreamCodes = new Set<string>(getAllRegions().map((region) => region.key));

    for (const region of UPSTREAM_CF_SYNC_REGION_CASES) {
      expect(upstreamCodes.has(region.code)).toBe(true);
    }
    expect(upstreamCodes.has('us10-004')).toBe(false);
  });

  it('injects the sorted cf-sync region catalog plus local fallback without duplicates', () => {
    const regions = readInjectedRegions(getScript('test-nonce'));
    const regionCodes = regions.map((region) => region.code);
    const sortedKeys = regions.map((region) => `${region.name} ${region.code}`);

    expect(new Set(regionCodes).size).toBe(regionCodes.length);
    expect(sortedKeys).toEqual([...sortedKeys].sort((a, b) => a.localeCompare(b)));
    expect(regions[0]?.code).toBe('ap12');
    expect(regions.some((region) => region.code === 'ae01')).toBe(true);
    expect(regions.some((region) => region.code === 'sa31')).toBe(true);
    expect(regions.some((region) => region.code === 'uk20')).toBe(true);
    for (const catalogRegion of UPSTREAM_CF_SYNC_REGION_CASES) {
      expect(regions.find((region) => region.code === catalogRegion.code)).toEqual(catalogRegion);
    }
    for (const fallbackRegion of LOCAL_WEBVIEW_FALLBACK_REGION_CASES) {
      expect(regions.find((region) => region.code === fallbackRegion.code)).toEqual(fallbackRegion);
    }
    expect(regions.find((region) => region.code === 'cn20')?.apiEndpoint)
      .toBe('https://api.cf.cn20.platform.sapcloud.cn');
    expect(regions.find((region) => region.code === 'cn40')?.apiEndpoint)
      .toBe('https://api.cf.cn40.platform.sapcloud.cn');
  });

  it('routes Change Mapping back to the CF Region / Org step', () => {
    const script = getScript('test-nonce');

    expect(script).toMatch(/\$\('btn-remap'\)\?\.addEventListener\('click'[\s\S]*?else \{\s+state\.screen = SCREENS\.REGION;/);
    expect(script).toMatch(/case 'PROCEED_CHANGE_MAPPING':\s+state\.screen = SCREENS\.REGION;/);
  });

  it('does not let late config restores override manual mapping flow', () => {
    const script = getScript('test-nonce');

    expect(script).toContain('suppressConfigAutoRestore: false');
    expect(script).toMatch(/\$\('btn-save-mapping'\)\?\.addEventListener\('click'[\s\S]*?state\.suppressConfigAutoRestore = true;/);
    expect(script).toMatch(/\$\('btn-remap'\)\?\.addEventListener\('click'[\s\S]*?state\.suppressConfigAutoRestore = true;/);
    expect(script).toMatch(/if \(!state\.credentialStatus\.hasCredentials\) \{\s+if \(state\.suppressConfigAutoRestore\) return;/);
    expect(script).toMatch(/if \(state\.suppressConfigAutoRestore\) return;\s+if \(cfg && state\.mappings\.length > 0\)/);
  });

  it('uses compatible MRU org mappings for webview save and restore flows', () => {
    const script = getScript('test-nonce');

    expect(script).toContain('function selectPreferredOrgMapping');
    expect(script).toContain('function upsertWebviewOrgMapping');
    expect(script).toMatch(/lastUsedAt:\s*Date\.now\(\)/);
    expect(script).toMatch(/state\.mappings\s*=\s*upsertWebviewOrgMapping\(state\.mappings,\s*mapping\)/);
    expect(script).toMatch(/const mapping = selectPreferredOrgMapping\(state\.orgs,\s*state\.mappings\);/);
  });

  it('does not trigger LOAD_APPS when SCOPE_SYNCED matches the selected org and space', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);

    harness.dispatch({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-alpha', spaceName: 'app' },
    });

    expect(harness.postedMessages).toEqual([]);
  });

  it('triggers LOAD_APPS when SCOPE_SYNCED changes org or space', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);

    harness.dispatch({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
    });

    expect(harness.postedMessages).toEqual([{
      type: 'LOAD_APPS',
      payload: { org: 'sample-org-beta', space: 'dev' },
    }]);
  });

  it('routes SCOPE_SYNCED_NO_MAPPING to folder selection without loading apps', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);

    harness.dispatch({
      type: 'SCOPE_SYNCED_NO_MAPPING',
      payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
    });

    expect(harness.postedMessages).toEqual([]);
    expect(harness.getHtml()).toContain('Select Local Folder');
    expect(harness.getHtml()).toContain('sample-org-beta');
    expect(harness.getHtml()).toContain('dev');
    expect(harness.getHtml()).toContain('No folder selected yet.');
    expect(harness.getHtml()).toMatch(/id="btn-save-mapping" disabled/);
  });

  it('restores cached folder when SCOPE_SYNCED_NO_MAPPING targets a known folder cache entry', () => {
    const harness = createWebviewScriptHarness();

    harness.dispatch({
      type: 'CONFIG_LOADED',
      payload: {
        config: {
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgs: ['sample-org-alpha', 'sample-org-beta'],
          orgGroupMappings: [
            {
              cfOrg: 'sample-org-alpha',
              cfSpace: 'app',
              groupFolderPath: '/tmp/sample-alpha',
            },
            {
              cfOrg: 'sample-org-beta',
              cfSpace: 'dev',
              groupFolderPath: '/tmp/sample-beta-dev',
            },
          ],
        },
        activeSessions: {},
        credentialStatus: {
          hasCredentials: true,
          email: 'sample.user@example.com',
          source: 'env',
        },
      },
    });
    harness.dispatch({ type: 'APPS_LOADED', payload: { apps: [] } });
    harness.postedMessages.length = 0;

    harness.dispatch({
      type: 'SCOPE_SYNCED_NO_MAPPING',
      payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
    });

    expect(harness.postedMessages).toEqual([]);
    expect(harness.getHtml()).toContain('Select Local Folder');
    expect(harness.getHtml()).toContain('/tmp/sample-beta-dev');
    expect(harness.getHtml()).not.toMatch(/id="btn-save-mapping" disabled/);
  });

  it('prefills a known region without leaving the current screen', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);

    harness.dispatch({
      type: 'REGION_PREFILL',
      payload: {
        regionCode: 'us10',
        apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
      },
    });

    expect(harness.getHtml()).toContain('Debug Launcher');
    expect(harness.getHtml()).toContain('us10');
    expect(harness.getHtml()).toContain('https://api.cf.us10.hana.ondemand.com');
    expect(harness.getHtml()).not.toContain('Select Local Folder');
  });

  it('prefills a custom region without leaving the current screen', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);

    harness.dispatch({
      type: 'REGION_PREFILL',
      payload: {
        regionCode: 'sample-custom',
        apiEndpoint: 'https://api.cf.sample-custom.hana.ondemand.com',
      },
    });

    expect(harness.getHtml()).toContain('Debug Launcher');
    expect(harness.getHtml()).toContain('sample-custom (custom)');
    expect(harness.getHtml()).toContain('https://api.cf.sample-custom.hana.ondemand.com');
    expect(harness.getHtml()).not.toContain('Select Local Folder');
  });

  it('updates the ready region label when LOGIN_SUCCESS includes a new endpoint', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);

    harness.dispatch({
      type: 'LOGIN_SUCCESS',
      payload: {
        orgs: ['sample-org-beta'],
        apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
      },
    });
    harness.dispatch({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-beta', spaceName: 'app' },
    });
    harness.dispatch({
      type: 'APPS_LOADED',
      payload: { apps: [] },
    });

    expect(harness.getHtml()).toContain('us10');
    expect(harness.getHtml()).toContain('sample-org-beta');
    expect(harness.getHtml()).toContain('https://api.cf.us10.hana.ondemand.com');
  });

  it('renders both the last successful sync and the skipped attempt reason', () => {
    const now = Date.now();
    const html = renderSettingsHtml({
      syncStatus: {
        isRunning: false,
        lastCompletedAt: now - 2 * 24 * 60 * 60 * 1000,
        lastAttemptedAt: now - 60 * 60 * 1000,
        lastSkipReason: 'no-credentials',
        done: 0,
        total: 5,
      },
      cacheConfig: { enabled: true, intervalHours: 24 },
    });

    expect(html).toContain('Last sync:');
    expect(html).toContain('2 days ago');
    expect(html).toContain('Last attempt');
    expect(html).toContain('credentials not set');
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
