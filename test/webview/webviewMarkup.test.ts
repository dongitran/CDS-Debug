import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { getAllRegions } from '@saptools/cf-sync';

import { getPackageBrowserScriptContent } from '../../src/webview/packageBrowserContent';
import { getPackageBrowserStyles } from '../../src/webview/packageBrowserStyles';
import { getScript } from '../../src/webview/webviewScript';
import { getRendererScriptContent } from '../../src/webview/webviewRenderers';
import { getWebviewContent } from '../../src/webview/getWebviewContent';

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
  readonly appWatchdogConfig?: {
    readonly enabled: boolean;
    readonly pingIntervalSeconds: number;
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
      appWatchdogConfig: options.appWatchdogConfig ?? { enabled: true, pingIntervalSeconds: 90 },
      sshProxyStatus: {
        enabled: false,
        host: '',
        port: 22,
        username: '',
        hasPassword: false,
        connection: 'disabled',
      },
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
  apps: readonly Record<string, unknown>[] = [],
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
    payload: { apps },
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

  it('ships a static fallback inside #app so a dead script is never a blank panel', () => {
    const html = getWebviewContent();

    expect(html).toContain('Loading CDS Debug');
    expect(html).toContain('Developer: Reload Window');
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
    expect(script).toMatch(/\$\('btn-remap'\)\?\.addEventListener\('click'[\s\S]*?else \{[\s\S]*?vscode\.postMessage\(\{ type: 'REQUEST_CHANGE_MAPPING' \}\);/);
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

  it('treats topology accounts with empty spaces as org-list only data', () => {
    const script = getScript('test-nonce');

    expect(script).toContain(
      'if (!account || !Array.isArray(account.spaces) || account.spaces.length === 0) return null;',
    );
  });

  it('passes the selected topology org during topology shortcut login', () => {
    const script = getScript('test-nonce');

    expect(script).toContain(
      "payload: { apiEndpoint: account.apiEndpoint, topologyOrgName: account.orgName }",
    );
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

  it('triggers LOAD_APPS when SCOPE_SYNCED changes org or space and topology misses', () => {
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

  it('uses topology apps for SCOPE_SYNCED without triggering LOAD_APPS', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);
    harness.dispatch({
      type: 'CF_TOPOLOGY',
      payload: {
        ready: true,
        accounts: [{
          regionKey: 'eu10',
          regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgName: 'sample-org-beta',
          spaces: [{
            name: 'dev',
            apps: [{ name: 'sample-service-beta', state: 'started', urls: [] }],
          }],
        }],
      },
    });
    harness.postedMessages.length = 0;

    harness.dispatch({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
    });

    expect(harness.postedMessages).toEqual([{
      type: 'WARMUP_CF_SESSION',
      payload: { org: 'sample-org-beta', space: 'dev' },
    }]);
    expect(harness.getHtml()).toContain('sample-service-beta');
  });

  it('falls back to LOAD_APPS when topology has a space error', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);
    harness.dispatch({
      type: 'CF_TOPOLOGY',
      payload: {
        ready: true,
        accounts: [{
          regionKey: 'eu10',
          regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgName: 'sample-org-beta',
          spaces: [{ name: 'dev', apps: [], error: 'mock sync failed' }],
        }],
      },
    });
    harness.postedMessages.length = 0;

    harness.dispatch({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
    });

    expect(harness.postedMessages).toEqual([{
      type: 'LOAD_APPS',
      payload: { org: 'sample-org-beta', space: 'dev' },
    }]);
  });

  it('falls back to LOAD_APPS when topology knows the space but has synced zero apps', () => {
    // An empty apps array (structure synced before apps, or legacy string spaces) used
    // to be served as-is: the launcher entered READY with no app rows and never ran the
    // live fetch — the "Debug Launcher is completely empty" report.
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness);
    harness.dispatch({
      type: 'CF_TOPOLOGY',
      payload: {
        ready: true,
        accounts: [{
          regionKey: 'eu10',
          regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgName: 'sample-org-beta',
          spaces: [{ name: 'dev', apps: [] }],
        }],
      },
    });
    harness.postedMessages.length = 0;

    harness.dispatch({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
    });

    expect(harness.postedMessages).toEqual([{
      type: 'LOAD_APPS',
      payload: { org: 'sample-org-beta', space: 'dev' },
    }]);
    expect(harness.getHtml()).toContain('Loading apps');
  });

  it('ignores stale app responses after session restore starts reconnecting', () => {
    const harness = createWebviewScriptHarness();
    harness.dispatch({
      type: 'CONFIG_LOADED',
      payload: {
        config: {
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgs: ['sample-org-alpha'],
          orgGroupMappings: [{
            cfOrg: 'sample-org-alpha',
            cfSpace: 'app',
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
    harness.dispatch({ type: 'APPS_ERROR', payload: { message: 'CF session expired' } });

    expect(harness.getHtml()).toContain('Session expired. Reconnecting');
    expect(harness.postedMessages.at(-1)).toEqual({
      type: 'LOGIN',
      payload: { apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com' },
    });

    harness.dispatch({ type: 'APPS_LOADED', payload: { apps: [] } });
    harness.dispatch({ type: 'APPS_ERROR', payload: { message: 'Late app load failure' } });

    expect(harness.getHtml()).toContain('Session expired. Reconnecting');
    expect(harness.getHtml()).not.toContain('Late app load failure');
  });

  it('recovers with a visible error screen when a renderer throws', () => {
    // A renderer exception used to leave the previous innerHTML frozen (or the initial
    // empty #app blank) with no diagnostics. The render boundary swaps in a recovery
    // screen and reports the failure to the extension log.
    const harness = createWebviewScriptHarness();
    harness.dispatch({
      type: 'CONFIG_LOADED',
      payload: {
        config: {
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgs: ['sample-org-alpha'],
          orgGroupMappings: [{
            cfOrg: 'sample-org-alpha',
            cfSpace: 'app',
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
    harness.postedMessages.length = 0;

    harness.dispatch({ type: 'APPS_LOADED', payload: { apps: null } });

    expect(harness.getHtml()).toContain('Reload Launcher');
    const errorReport = harness.postedMessages.find((message) => message.type === 'WEBVIEW_ERROR');
    expect(errorReport).toBeDefined();
    expect((errorReport?.payload as { context?: string } | undefined)?.context).toBe('render');
  });

  it('restores a mapped session from topology without triggering LOAD_APPS', () => {
    const harness = createWebviewScriptHarness();
    harness.dispatch({
      type: 'CF_TOPOLOGY',
      payload: {
        ready: true,
        accounts: [{
          regionKey: 'eu10',
          regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgName: 'sample-org-alpha',
          spaces: [{
            name: 'app',
            apps: [{ name: 'sample-service-alpha', state: 'started', urls: [] }],
          }],
        }],
      },
    });
    harness.postedMessages.length = 0;

    harness.dispatch({
      type: 'CONFIG_LOADED',
      payload: {
        config: {
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgs: ['sample-org-alpha'],
          orgGroupMappings: [{
            cfOrg: 'sample-org-alpha',
            cfSpace: 'app',
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

    expect(harness.postedMessages).toEqual([{
      type: 'WARMUP_CF_SESSION',
      payload: { org: 'sample-org-alpha', space: 'app' },
    }]);
    expect(harness.getHtml()).toContain('sample-service-alpha');
    expect(harness.getHtml()).not.toContain('Loading apps for');
  });

  it('restores after credentials are saved from topology without triggering LOAD_APPS', () => {
    const harness = createWebviewScriptHarness();
    harness.dispatch({
      type: 'CF_TOPOLOGY',
      payload: {
        ready: true,
        accounts: [{
          regionKey: 'eu10',
          regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgName: 'sample-org-alpha',
          spaces: [{
            name: 'app',
            apps: [{ name: 'sample-service-alpha', state: 'started', urls: [] }],
          }],
        }],
      },
    });
    harness.dispatch({
      type: 'CONFIG_LOADED',
      payload: {
        config: {
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgs: ['sample-org-alpha'],
          orgGroupMappings: [{
            cfOrg: 'sample-org-alpha',
            cfSpace: 'app',
            groupFolderPath: '/tmp/sample-folder',
          }],
        },
        activeSessions: {},
        credentialStatus: {
          hasCredentials: false,
          email: '',
          source: 'none',
        },
      },
    });
    harness.postedMessages.length = 0;

    harness.dispatch({
      type: 'CREDENTIALS_SAVED',
      payload: { email: 'sample.user@example.com', source: 'keychain' },
    });

    expect(harness.postedMessages).toEqual([{
      type: 'WARMUP_CF_SESSION',
      payload: { org: 'sample-org-alpha', space: 'app' },
    }]);
    expect(harness.getHtml()).toContain('sample-service-alpha');
  });

  it('updates Ready apps when a fresher topology arrives for the current target', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness, 'sample-org-alpha', 'app', [
      { name: 'sample-service-old', state: 'started', urls: [] },
    ]);

    harness.dispatch({
      type: 'CF_TOPOLOGY',
      payload: {
        ready: true,
        accounts: [{
          regionKey: 'eu10',
          regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
          orgName: 'sample-org-alpha',
          spaces: [{
            name: 'app',
            apps: [{ name: 'sample-service-new', state: 'started', urls: [] }],
          }],
        }],
      },
    });

    expect(harness.getHtml()).toContain('sample-service-new');
    expect(harness.getHtml()).not.toContain('sample-service-old');
  });

  it('renders instance count badges instead of started text when counts are available', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness, 'sample-org-alpha', 'app', [
      { name: 'sample-service-started', state: 'started', runningInstances: 1, totalInstances: 1, urls: [] },
      { name: 'sample-service-empty', state: 'empty', runningInstances: 0, totalInstances: 1, urls: [] },
    ]);

    const html = harness.getHtml();
    expect(html).toContain('badge badge-started badge-scale');
    expect(html).toContain('1/1');
    expect(html).toContain('>0/1</span>');
    expect(html).not.toContain('badge badge-started">started</span>');
  });

  it('renders safe instance badges as buttons and keeps stopped badges non-clickable', () => {
    const harness = createWebviewScriptHarness();
    moveHarnessToReadyScreen(harness, 'sample-org-alpha', 'app', [
      {
        name: 'sample-service-started',
        state: 'started',
        runningInstances: 1,
        totalInstances: 1,
        instanceProcessCount: 1,
        urls: [],
      },
      {
        name: 'sample-service-stopped',
        state: 'stopped',
        runningInstances: 0,
        totalInstances: 1,
        instanceProcessCount: 1,
        urls: [],
      },
      {
        name: 'sample-service-multi',
        state: 'started',
        runningInstances: 2,
        totalInstances: 2,
        instanceProcessCount: 2,
        urls: [],
      },
    ]);

    const html = harness.getHtml();
    expect(html).toContain('class="badge badge-started badge-scale"');
    expect(html).toContain('data-scale-app="sample-service-started"');
    expect(html).toContain('aria-label="Scale sample-service-started instances (1/1)"');
    expect(html).toContain('class="badge badge-stopped badge-scale-disabled"');
    expect(html).toContain('>0/1</span>');
    expect(html).toContain('title="Scaling multiple CF processes is not supported from this badge yet"');
    expect(html).not.toContain('data-scale-app="sample-service-stopped"');
    expect(html).not.toContain('data-scale-app="sample-service-multi"');
  });

  it('wires instance scaling through a confirmation message instead of direct badge action', () => {
    const script = getScript('test-nonce');

    expect(script).toContain("type: 'SCALE_APP_INSTANCES'");
    expect(script).toContain('data-scale-apply');
    expect(script).toContain('state.instanceScalePopover');
    expect(script).toContain('state.scalePendingAppName');
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

  it('renders the App Watchdog section with the interval selector enabled', () => {
    const html = renderSettingsHtml({
      syncStatus: { isRunning: false, done: 0, total: 0 },
      cacheConfig: { enabled: true, intervalHours: 24 },
      appWatchdogConfig: { enabled: true, pingIntervalSeconds: 90 },
    });

    expect(html).toContain('App Watchdog');
    expect(html).toContain('chk-watchdog-enabled');
    expect(html).toContain('select-watchdog-interval');
    expect(html).toContain('<option value="60">1 minute</option>');
    expect(html).toContain('<option value="90" selected>90 seconds (default)</option>');
    expect(html).toContain('<option value="120">2 minutes</option>');
    expect(html).toContain('<option value="300">5 minutes</option>');
    expect(html).not.toContain('<option value="10"');
    expect(html).not.toContain('<option value="15"');
    expect(html).not.toContain('<option value="30"');
    expect(html).toContain('watchDurationHours');
  });

  it('renders password-only SSH proxy controls without exposing a key mode', () => {
    const html = renderSettingsHtml({
      syncStatus: { isRunning: false, done: 0, total: 0 },
      cacheConfig: { enabled: true, intervalHours: 24 },
    });

    expect(html).toContain('SSH Proxy');
    expect(html).toContain('chk-ssh-proxy-enabled');
    expect(html).toContain('ssh-proxy-host');
    expect(html).toContain('ssh-proxy-port');
    expect(html).toContain('ssh-proxy-username');
    expect(html).toContain('type="password"');
    expect(html).toContain('Save & Test');
    expect(html).not.toContain('SSH key');
  });

  it('disables the watchdog interval selector and offers custom values when configured', () => {
    const html = renderSettingsHtml({
      syncStatus: { isRunning: false, done: 0, total: 0 },
      cacheConfig: { enabled: true, intervalHours: 24 },
      appWatchdogConfig: { enabled: false, pingIntervalSeconds: 75 },
    });

    expect(html).toMatch(/<select class="select" id="select-watchdog-interval"\s+disabled\s*>/);
    expect(html).toContain('<option value="75" selected>75 seconds (custom)</option>');
  });

  it('shows automatic retry copy for retryable sync failures', () => {
    const now = Date.now();
    const html = renderSettingsHtml({
      syncStatus: {
        isRunning: false,
        lastCompletedAt: now - 2 * 24 * 60 * 60 * 1000,
        lastAttemptedAt: now - 60 * 60 * 1000,
        lastSkipReason: 'aborted',
        done: 0,
        total: 5,
      },
      cacheConfig: { enabled: true, intervalHours: 24 },
    });

    expect(html).toContain('sync was canceled');
    expect(html).toContain('retry scheduled automatically');
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

function runPackageBrowserScript(state: Record<string, unknown>): {
  readonly call: (fn: string) => void;
  readonly posted: PostedMessage[];
  readonly renderCount: () => number;
} {
  let renders = 0;
  const posted: PostedMessage[] = [];
  const context: Record<string, unknown> = {
    state,
    SCREENS: { PACKAGES: 'packages', READY: 'ready' },
    render: (): void => { renders += 1; },
    vscode: {
      postMessage: (message: PostedMessage): void => { posted.push(message); },
    },
  };
  // The package browser script is a series of function declarations, so running it in a
  // fresh context exposes each helper as a context property we can call directly.
  vm.runInNewContext(getPackageBrowserScriptContent(), context, { timeout: 1000 });
  return {
    call: (fn: string): void => {
      const target = context[fn];
      if (typeof target !== 'function') throw new Error(`Function ${fn} was not defined`);
      (target as () => void)();
    },
    posted,
    renderCount: (): number => renders,
  };
}

function makePackagesState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    screen: 'packages',
    packageBrowserAppName: 'sample-service',
    packageBrowserSearchQuery: '',
    packageBrowserLoading: false,
    packageBrowserError: null,
    packageBaseEntries: [],
    packageEntries: [],
    packageSearchRequestId: 0,
    packageSearchPending: false,
    expandedPackageBranchIds: [],
    searchPackageBranchStates: {},
    selectedPackageFileId: null,
    activeSessions: { 'sample-service': { status: 'ATTACHED' } },
    ...overrides,
  };
}

describe('package browser returns to launcher when the session ends', () => {
  it('stays on the Packages screen while the browsed app is still attached', () => {
    const state = makePackagesState();
    const harness = runPackageBrowserScript(state);

    harness.call('syncPackageBrowserAppSelection');

    expect(state.screen).toBe('packages');
    expect(state.packageBrowserAppName).toBe('sample-service');
  });

  it('returns to the launcher when the browsed app debug session exits', () => {
    const state = makePackagesState({ activeSessions: {} });
    const harness = runPackageBrowserScript(state);

    harness.call('syncPackageBrowserAppSelection');

    expect(state.screen).toBe('ready');
    expect(state.packageBrowserAppName).toBeNull();
    expect(state.packageEntries).toEqual([]);
    expect(state.packageBaseEntries).toEqual([]);
  });

  it('returns to the launcher when the browsed app drops to a non-attached status (crash/reconnect)', () => {
    const state = makePackagesState({
      activeSessions: { 'sample-service': { status: 'TUNNELING' } },
    });
    const harness = runPackageBrowserScript(state);

    harness.call('syncPackageBrowserAppSelection');

    expect(state.screen).toBe('ready');
    expect(state.packageBrowserAppName).toBeNull();
  });

  it('returns to the launcher even if a different app is still attached', () => {
    const state = makePackagesState({
      activeSessions: { 'other-service': { status: 'ATTACHED' } },
    });
    const harness = runPackageBrowserScript(state);

    harness.call('syncPackageBrowserAppSelection');

    // Does not silently switch to another app — goes back to app selection.
    expect(state.screen).toBe('ready');
    expect(state.packageBrowserAppName).toBeNull();
  });

  it('does nothing when not on the Packages screen', () => {
    const state = makePackagesState({ screen: 'ready', activeSessions: {} });
    const harness = runPackageBrowserScript(state);

    harness.call('syncPackageBrowserAppSelection');

    expect(state.screen).toBe('ready');
    expect(harness.renderCount()).toBe(0);
  });
});
