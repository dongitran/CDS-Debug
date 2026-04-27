import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from '@playwright/test';
import {
  appendDiagnostic,
  buildFailureError,
  captureStepEvidence,
  createSessionDiagnostics,
  persistSessionArtifacts,
  type SessionDiagnostics,
} from '../support/sessionEvidence';

type CredentialMode = 'env' | 'none';
type CfScenario =
  | 'success'
  | 'auth-fail'
  | 'no-orgs'
  | 'apps-fail'
  | 'slow-auth'
  | 'slow-apps'
  | 'slow-target'
  | 'slow-target-after-apps'
  | 'reload-changes'
  | 'multi-spaces';

interface SessionOptions {
  credentialMode: CredentialMode;
  cfScenario: CfScenario;
  userSettings?: Record<string, unknown>;
}

interface SessionArtifacts {
  appProcess?: ChildProcessWithoutNullStreams;
  browser?: Browser;
  workbenchPage?: Page;
  userDataDir: string;
  extensionsDir: string;
  mockBinDir: string;
}

interface FixturePackageFile {
  id: string;
  label: string;
  relativePath: string;
  source: {
    name: string;
    path: string;
  };
}

interface FixtureFolderBuilder {
  name: string;
  path: string;
  folders: Map<string, FixtureFolderBuilder>;
  files: FixturePackageFile[];
}

interface FixturePackageSpec {
  name: string;
  files: Array<string | { relativePath: string; content: string }>;
  version?: string;
}

interface FixtureLoadedSourcesPlanStep {
  kind: 'packages' | 'empty' | 'error' | 'hang';
  delayMs?: number;
  message?: string;
}

interface FixtureSessionAvailability {
  childSessionDelayMs?: number;
}

const MOCK_ENV_EMAIL = 'e2e.mock.user@example.com';
const MOCK_ENV_PASSWORD = 'e2e-mock-password';
const MOCK_GROUP_FOLDER = '/tmp/cds-debug-e2e-group';
const WEBSOCKET_TIMEOUT_MS = 90_000;
const FRAME_TIMEOUT_MS = 90_000;
const MOCK_SLOW_TARGET_DELAY_SECONDS = 8;
const STEP_OBSERVE_DELAY_MS = (() => {
  const value = Number(process.env.CDS_DEBUG_E2E_STEP_DELAY_MS ?? '0');
  return Number.isFinite(value) && value > 0 ? value : 0;
})();

async function waitForObservation(): Promise<void> {
  if (STEP_OBSERVE_DELAY_MS <= 0) return;
  await delay(STEP_OBSERVE_DELAY_MS);
}

function buildMockCfScript(scenario: CfScenario): string {
  return `#!/usr/bin/env bash
set -euo pipefail

SCENARIO="${scenario}"
cmd="\${1:-}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
slow_target_after_apps_ready="$script_dir/.slow-target-after-apps-ready"
slow_target_after_apps_used="$script_dir/.slow-target-after-apps-used"
reload_apps_count="$script_dir/.reload-apps-count"

case "$cmd" in
  api)
    echo "Setting API endpoint to \${2:-}..."
    echo "OK"
    ;;
  auth)
    if [[ "$SCENARIO" == "auth-fail" ]]; then
      echo "mock auth failed" >&2
      exit 1
    fi
    if [[ "$SCENARIO" == "slow-auth" ]]; then
      sleep 30
    fi
    echo "Authenticating..."
    echo "OK"
    ;;
  logout)
    echo "OK"
    ;;
  orgs)
    if [[ "$SCENARIO" == "no-orgs" ]]; then
      echo "name"
      exit 0
    fi
    cat <<'OUT'
Getting orgs as e2e.mock.user@example.com...
name
mock-org-alpha
mock-org-beta
OUT
    ;;
  spaces)
    if [[ "$SCENARIO" == "multi-spaces" ]]; then
      cat <<'OUT'
name
app
dev
OUT
    else
      cat <<'OUT'
name
app
OUT
    fi
    ;;
  target)
    if [[ "$SCENARIO" == "slow-target" ]]; then
      sleep ${MOCK_SLOW_TARGET_DELAY_SECONDS}
    fi
    if [[ "$SCENARIO" == "slow-target-after-apps" && -f "$slow_target_after_apps_ready" && ! -f "$slow_target_after_apps_used" ]]; then
      touch "$slow_target_after_apps_used"
      sleep ${MOCK_SLOW_TARGET_DELAY_SECONDS}
    fi
    echo "OK"
    ;;
  apps)
    if [[ "$SCENARIO" == "apps-fail" ]]; then
      echo "mock apps load failed" >&2
      exit 1
    fi
    if [[ "$SCENARIO" == "slow-apps" ]]; then
      sleep 30
    fi
    if [[ "$SCENARIO" == "slow-target-after-apps" ]]; then
      touch "$slow_target_after_apps_ready"
    fi
    if [[ "$SCENARIO" == "reload-changes" ]]; then
      count=0
      if [[ -f "$reload_apps_count" ]]; then
        count="$(cat "$reload_apps_count")"
      fi
      next_count=$((count + 1))
      echo "$next_count" > "$reload_apps_count"
      if [[ "$next_count" -eq 1 ]]; then
        cat <<'OUT'
name   requested state   processes   routes
mock-service-a   started   1/1   mock-service-a.cfapps.example.com
mock-service-b   stopped   0/1   mock-service-b.cfapps.example.com
mock-service-c   started   2/2   mock-service-c.cfapps.example.com
OUT
      else
        cat <<'OUT'
name   requested state   processes   routes
mock-service-a   started   1/1   mock-service-a.cfapps.example.com
mock-service-b   stopped   0/1   mock-service-b.cfapps.example.com
mock-service-d   started   1/1   mock-service-d.cfapps.example.com
OUT
      fi
      exit 0
    fi
    cat <<'OUT'
name   requested state   processes   routes
mock-service-a   started   1/1   mock-service-a.cfapps.example.com
mock-service-b   stopped   0/1   mock-service-b.cfapps.example.com
mock-service-c   started   2/2   mock-service-c.cfapps.example.com
OUT
    ;;
  ssh-enabled)
    echo "ssh support is enabled for app \${2:-}"
    ;;
  enable-ssh|restart)
    echo "OK"
    ;;
  *)
    echo "mock cf: unsupported command: $cmd (scenario: $SCENARIO)" >&2
    exit 1
    ;;
esac
`;
}

async function createTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeUserSettings(userDataDir: string, settings: Record<string, unknown>): Promise<void> {
  const settingsDir = join(userDataDir, 'User');
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf8',
  );
}

async function createWorkspaceWithLaunchJson(configurations: Record<string, unknown>[]): Promise<string> {
  const workspaceDir = await createTempDirectory('cds-debug-e2e-workspace-');
  const vscodeDir = join(workspaceDir, '.vscode');
  await mkdir(vscodeDir, { recursive: true });
  await writeFile(
    join(vscodeDir, 'launch.json'),
    JSON.stringify({ version: '0.2.0', configurations }, null, 2) + '\n',
    'utf8',
  );
  return workspaceDir;
}

interface CapConfigWorkspaceOptions {
  workspaceConfig?: Record<string, unknown>;
  serviceConfig?: Record<string, unknown>;
}

async function createWorkspaceForCapConfigTest(options: CapConfigWorkspaceOptions): Promise<string> {
  const workspaceDir = await createTempDirectory('cds-debug-e2e-cap-config-');
  const vscodeDir = join(workspaceDir, '.vscode');
  const serviceDir = join(workspaceDir, 'mock-service-a');

  await mkdir(vscodeDir, { recursive: true });
  await mkdir(serviceDir, { recursive: true });
  await writeFile(join(serviceDir, 'package.json'), JSON.stringify({ name: 'sample-service' }, null, 2) + '\n', 'utf8');

  if (options.workspaceConfig !== undefined) {
    await writeFile(
      join(vscodeDir, 'cap-debug-config.json'),
      JSON.stringify(options.workspaceConfig, null, 2) + '\n',
      'utf8',
    );
  }

  if (options.serviceConfig !== undefined) {
    await writeFile(
      join(serviceDir, 'cap-debug-config.json'),
      JSON.stringify(options.serviceConfig, null, 2) + '\n',
      'utf8',
    );
  }

  return workspaceDir;
}

async function readLaunchJson(workspaceDir: string): Promise<{ configurations: Record<string, unknown>[] }> {
  const raw = await readFile(join(workspaceDir, '.vscode', 'launch.json'), 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('launch.json content is not an object.');
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.configurations)) {
    throw new Error('launch.json configurations is not an array.');
  }

  const configurations = record.configurations.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
  return { configurations };
}

async function readManagedRemoteRoot(workspaceDir: string, appName: string): Promise<string | null> {
  try {
    const launchJson = await readLaunchJson(workspaceDir);
    const config = launchJson.configurations.find((item) => item.name === `Debug: ${appName}`);
    return typeof config?.remoteRoot === 'string' ? config.remoteRoot : null;
  } catch {
    return null;
  }
}

async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a TCP port.'));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function createMockCfCli(mockBinDir: string, scenario: CfScenario): Promise<void> {
  const cfPath = join(mockBinDir, 'cf');
  const script = buildMockCfScript(scenario);
  await writeFile(cfPath, script, 'utf8');
  await chmod(cfPath, 0o755);
}

function buildVsCodeEnv(mockBinDir: string, credentialMode: CredentialMode, userDataDir: string): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH ?? '';
  const credentials = credentialMode === 'env'
    ? { SAP_EMAIL: MOCK_ENV_EMAIL, SAP_PASSWORD: MOCK_ENV_PASSWORD }
    : { SAP_EMAIL: '', SAP_PASSWORD: '' };

  return {
    ...process.env,
    ...credentials,
    CDS_DEBUG_DISABLE_BACKGROUND_SYNC: '1',
    CDS_DEBUG_E2E_MODE: '1',
    CDS_DEBUG_CF_STRUCTURE_PATH: join(userDataDir, '.saptools', 'cf-structure.json'),
    SHELL: '/usr/bin/false',
    PATH: `${mockBinDir}${delimiter}${inheritedPath}`,
  };
}

function launchVsCode(
  repoRoot: string,
  userDataDir: string,
  extensionsDir: string,
  cdpPort: number,
  env: NodeJS.ProcessEnv,
  workspaceDir?: string,
): ChildProcessWithoutNullStreams {
  const args = [
    '--user-data-dir', userDataDir,
    '--extensions-dir', extensionsDir,
    '--new-window',
    '--wait',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    `--remote-debugging-port=${cdpPort.toString()}`,
    `--extensionDevelopmentPath=${repoRoot}`,
    workspaceDir ?? repoRoot,
  ];

  return spawn('code', args, {
    cwd: repoRoot,
    env,
    stdio: 'pipe',
  });
}

async function waitForCdpEndpoint(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${port.toString()}/json/version`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // Endpoint is not ready yet.
    }
    await delay(250);
  }

  throw new Error(`CDP endpoint did not become ready on port ${port.toString()}.`);
}

async function waitForWorkbenchPage(context: BrowserContext): Promise<Page> {
  const deadline = Date.now() + WEBSOCKET_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (page.url().includes('workbench.html')) {
        return page;
      }
    }

    const nextPage = await context.waitForEvent('page', { timeout: 1_000 }).catch(() => null);
    if (nextPage && nextPage.url().includes('workbench.html')) {
      return nextPage;
    }
  }

  throw new Error('Could not find VS Code workbench page.');
}

async function openExtensionView(workbenchPage: Page): Promise<void> {
  const activityBarItem = workbenchPage
    .locator('[id="workbench.parts.activitybar"] [aria-label="CDS Debug"]')
    .first();

  await expect(activityBarItem).toBeVisible({ timeout: FRAME_TIMEOUT_MS });
  await activityBarItem.click();
}

async function waitForExtensionWebviewFrame(workbenchPage: Page): Promise<Frame> {
  const markers = [
    'CF Region',
    'Login to Cloud Foundry',
    'Setup Credentials',
    'Select CF Org',
    'Select CF Space',
    'Select Local Folder',
    'Debug Launcher',
    'Settings',
    'Preparing Branches',
  ];
  const deadline = Date.now() + FRAME_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const frame of workbenchPage.frames()) {
      if (frame.url().includes('workbench.html')) continue;
      try {
        const text = await frame.locator('body').innerText();
        if (markers.some((marker) => text.includes(marker))) {
          return frame;
        }
      } catch {
        // Frame may not be readable yet.
      }
    }
    await delay(250);
  }

  throw new Error('Could not find CDS Debug webview frame.');
}

async function terminateProcess(
  process: ChildProcessWithoutNullStreams,
  browser?: Browser,
  workbenchPage?: Page,
): Promise<void> {
  if (process.exitCode !== null) return;

  if (browser) {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close');
    } catch {
      // Fallback to keyboard/signal shutdown below.
    }
  }

  if (process.exitCode !== null) return;

  if (workbenchPage) {
    try {
      await workbenchPage.bringToFront();
      await workbenchPage.locator('body').click();
      await workbenchPage.keyboard.press('Meta+Shift+W');
    } catch {
      // Fallback to signal shutdown.
    }
  }

  const exited = await Promise.race([
    once(process, 'exit').then(() => true),
    delay(10_000).then(() => false),
  ]);
  if (exited || process.exitCode !== null) return;

  process.kill('SIGTERM');
  const exitedAfterSigterm = await Promise.race([
    once(process, 'exit').then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (exitedAfterSigterm || process.exitCode !== null) return;

  process.kill('SIGKILL');
  await once(process, 'exit');
}

async function removeDirWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await delay(500);
    }
  }

  await rm(path, { recursive: true, force: true });
}

async function terminateProcessesMatching(pattern: string): Promise<void> {
  const child = spawn('pkill', ['-f', pattern], { stdio: 'ignore' });
  const [code] = await once(child, 'close');
  if (code === 0 || code === 1) return;
  throw new Error(`pkill -f ${pattern} exited with code ${code?.toString() ?? 'null'}.`);
}

async function cleanupSessionHelpers(userDataDir: string, mockBinDir: string): Promise<void> {
  await terminateProcessesMatching(userDataDir).catch(() => undefined);
  await terminateProcessesMatching(mockBinDir).catch(() => undefined);
}

async function createSessionArtifacts(options: SessionOptions): Promise<SessionArtifacts> {
  const userDataDir = await createTempDirectory('cds-debug-e2e-user-');
  const extensionsDir = await createTempDirectory('cds-debug-e2e-extensions-');
  const mockBinDir = await createTempDirectory('cds-debug-e2e-bin-');
  await createMockCfCli(mockBinDir, options.cfScenario);
  if (options.userSettings !== undefined) {
    await writeUserSettings(userDataDir, options.userSettings);
  }

  return {
    userDataDir,
    extensionsDir,
    mockBinDir,
  };
}

async function withVsCodeSession(
  options: SessionOptions,
  run: (workbenchPage: Page) => Promise<void>,
  workspaceDir?: string,
): Promise<void> {
  const repoRoot = resolve(process.cwd(), '..');
  const cdpPort = await allocatePort();
  const artifacts = await createSessionArtifacts(options);
  const diagnostics: SessionDiagnostics = createSessionDiagnostics();

  try {
    const env = buildVsCodeEnv(artifacts.mockBinDir, options.credentialMode, artifacts.userDataDir);
    artifacts.appProcess = launchVsCode(
      repoRoot,
      artifacts.userDataDir,
      artifacts.extensionsDir,
      cdpPort,
      env,
      workspaceDir,
    );
    artifacts.appProcess.stdout.on('data', (chunk: Buffer | string) => {
      appendDiagnostic(diagnostics.vscodeStdout, chunk.toString());
    });
    artifacts.appProcess.stderr.on('data', (chunk: Buffer | string) => {
      appendDiagnostic(diagnostics.vscodeStderr, chunk.toString());
    });

    await waitForCdpEndpoint(cdpPort, WEBSOCKET_TIMEOUT_MS);
    artifacts.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort.toString()}`);

    const context = artifacts.browser.contexts()[0];
    if (!context) {
      throw new Error('No browser context was created for VS Code.');
    }

    artifacts.workbenchPage = await waitForWorkbenchPage(context);
    artifacts.workbenchPage.on('console', (msg) => {
      appendDiagnostic(
        diagnostics.browserConsole,
        `[${msg.type()}] ${msg.text()}`,
      );
    });
    artifacts.workbenchPage.on('pageerror', (err) => {
      appendDiagnostic(diagnostics.pageErrors, err.message);
    });
    artifacts.workbenchPage.on('requestfailed', (request) => {
      appendDiagnostic(
        diagnostics.requestFailures,
        `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown error'}`,
      );
    });
    await artifacts.workbenchPage.bringToFront();
    await captureStepEvidence(artifacts.workbenchPage, 'workbench-opened');
    await run(artifacts.workbenchPage);
    await persistSessionArtifacts({
      diagnostics,
      label: 'session-final',
      page: artifacts.workbenchPage,
    });
  } catch (error: unknown) {
    await persistSessionArtifacts({
      diagnostics,
      error,
      label: 'session-failure',
      page: artifacts.workbenchPage,
    }).catch(() => undefined);
    throw buildFailureError(error, diagnostics);
  } finally {
    if (artifacts.appProcess) {
      await terminateProcess(artifacts.appProcess, artifacts.browser, artifacts.workbenchPage);
    }

    if (artifacts.browser) {
      await artifacts.browser.close().catch(() => undefined);
    }

    await cleanupSessionHelpers(artifacts.userDataDir, artifacts.mockBinDir);
    await removeDirWithRetry(artifacts.userDataDir);
    await removeDirWithRetry(artifacts.extensionsDir);
    await removeDirWithRetry(artifacts.mockBinDir);
  }
}

async function openCdsDebugWebview(workbenchPage: Page): Promise<Frame> {
  await openExtensionView(workbenchPage);
  await expect(workbenchPage.locator('iframe.webview').first()).toBeVisible({ timeout: FRAME_TIMEOUT_MS });
  return waitForExtensionWebviewFrame(workbenchPage);
}

async function loginFromRegionScreen(webview: Frame): Promise<void> {
  await webview.getByRole('button', { name: 'Login to Cloud Foundry' }).click();
}

async function expectRegionScreen(webview: Frame): Promise<void> {
  await expect(webview.locator('.step-badge', { hasText: '1/3' })).toBeVisible();
  await expect(webview.getByText('CF Region')).toBeVisible();
  await expect(webview.getByText('Select Region')).toBeVisible();
  await expect(webview.getByLabel('Search regions')).toBeVisible();
  await expect(webview.getByRole('radiogroup', { name: 'Cloud Foundry regions' })).toBeVisible();
  await expect(webview.getByRole('button', { name: 'Login to Cloud Foundry' })).toBeVisible();
  // Region cards are rendered with radio inputs for every region
  await expect(webview.getByRole('radio', { name: /eu10/i })).toBeAttached();
  await expect(webview.getByRole('radio', { name: /us10/i })).toBeAttached();
  await expect(webview.getByRole('radio', { name: /ae01/i })).toBeAttached();
  await expect(webview.getByRole('radio', { name: /cn40/i })).toBeAttached();
  await expect(webview.getByRole('radio', { name: /sa31/i })).toBeAttached();
  // Custom endpoint card is always present
  await expect(webview.getByRole('radio', { name: /Custom endpoint/i })).toBeAttached();
  // Region screen must not leak launcher/setup controls
  await expect(webview.locator('#search-input')).toHaveCount(0);
  await expect(webview.locator('#btn-start-debug')).toHaveCount(0);
  await expect(webview.locator('#btn-save-mapping')).toHaveCount(0);
  await expect(webview.locator('#cred-email')).toHaveCount(0);
}

async function expectSetupCredentialsScreen(webview: Frame): Promise<void> {
  await expect(webview.getByText(/Setup Credentials|Update Credentials/)).toBeVisible();
  // Info box about secure keychain storage
  await expect(webview.locator('.info-box', { hasText: /keychain/i })).toBeVisible();
  // Section labels for email and password fields
  await expect(webview.locator('.section-label', { hasText: 'Email' })).toBeVisible();
  await expect(webview.getByPlaceholder('your.name@company.com')).toBeVisible();
  await expect(webview.locator('.section-label', { hasText: 'Password' })).toBeVisible();
  await expect(webview.getByPlaceholder('Password')).toBeVisible();
  // Password visibility toggle and save/continue button must always be present
  await expect(webview.locator('#btn-toggle-pwd')).toBeVisible();
  await expect(webview.locator('#btn-save-creds')).toBeVisible();
  // Setup screen must not leak launcher/region controls
  await expect(webview.locator('#search-input')).toHaveCount(0);
  await expect(webview.locator('#btn-start-debug')).toHaveCount(0);
  await expect(webview.locator('#btn-login')).toHaveCount(0);
}

async function expectReadyScreen(webview: Frame): Promise<void> {
  await expect(webview.getByText('Debug Launcher')).toBeVisible();
  await expect(webview.locator('#search-input')).toBeVisible();
  await expect(webview.locator('#btn-start-debug')).toBeVisible();
  await expect(webview.locator('#btn-refresh-apps')).toBeVisible();
  await expect(webview.locator('#btn-gear')).toBeVisible();
  // Ready screen must not leak login/setup/folder loading controls
  await expect(webview.locator('#btn-login')).toHaveCount(0);
  await expect(webview.locator('#btn-cancel-login')).toHaveCount(0);
  await expect(webview.locator('#btn-save-mapping')).toHaveCount(0);
  await expect(webview.locator('#btn-cancel-load-apps')).toHaveCount(0);
  await expect(webview.locator('#cred-email')).toHaveCount(0);
  await expect(webview.locator('#cred-password')).toHaveCount(0);
}

async function goToOrgSelection(webview: Frame): Promise<void> {
  await expectRegionScreen(webview);
  await loginFromRegionScreen(webview);
  await expect(webview.getByText('Select CF Org')).toBeVisible();
}

async function goToFolderSelection(webview: Frame, orgName = 'mock-org-alpha'): Promise<void> {
  await goToOrgSelection(webview);
  await webview.locator(`input[name="cf-org"][value="${orgName}"]`).check({ force: true });
  await webview.locator('#btn-next-org').click();
  await expect(webview.getByText('Select Local Folder')).toBeVisible();
}

async function injectSelectedFolder(webview: Frame, folderPath: string): Promise<void> {
  await webview.evaluate((path) => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'GROUP_FOLDER_SELECTED', payload: { path } },
    }));
  }, folderPath);
}

async function injectMessage(webview: Frame, message: Record<string, unknown>): Promise<void> {
  await webview.evaluate((msg) => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  }, message);
}

async function postExtensionMessage(webview: Frame, message: Record<string, unknown>): Promise<void> {
  await webview.evaluate((msg) => {
    type BridgeWindow = Window & {
      __cdsDebugPostMessage?: (payload: Record<string, unknown>) => void;
    };

    const bridgeWindow = window as BridgeWindow;
    if (typeof bridgeWindow.__cdsDebugPostMessage !== 'function') {
      throw new Error('CDS Debug test bridge is not available in the webview.');
    }
    bridgeWindow.__cdsDebugPostMessage(msg);
  }, message);
}

async function sendE2eBridgeCommand(webview: Frame, payload: Record<string, unknown>): Promise<void> {
  await postExtensionMessage(webview, { type: 'E2E_BRIDGE', payload });
}

async function emitDebugConnecting(
  webview: Frame,
  payload: { appNames: string[]; ports: Record<string, number>; unmappedApps?: string[] },
): Promise<void> {
  await sendE2eBridgeCommand(webview, {
    action: 'EMIT_DEBUG_CONNECTING',
    payload,
  });
}

async function emitAppDebugStatus(
  webview: Frame,
  payload: { appName: string; status: string; message?: string },
): Promise<void> {
  await sendE2eBridgeCommand(webview, {
    action: 'EMIT_APP_DEBUG_STATUS',
    payload,
  });
}

async function setPackageFixture(
  webview: Frame,
  appName: string,
  packages: Record<string, unknown>[],
  options?: {
    loadedSourcesPlan?: FixtureLoadedSourcesPlanStep[];
    localRoot?: string;
    sessionAvailability?: FixtureSessionAvailability;
  },
): Promise<void> {
  await sendE2eBridgeCommand(webview, {
    action: 'SET_PACKAGE_FIXTURE',
    payload: {
      appName,
      packages,
      loadedSourcesPlan: options?.loadedSourcesPlan,
      localRoot: options?.localRoot,
      sessionAvailability: options?.sessionAvailability,
    },
  });
}

async function clearPackageFixtures(webview: Frame): Promise<void> {
  await sendE2eBridgeCommand(webview, { action: 'CLEAR_PACKAGE_FIXTURES' });
}

async function setCredentialStatusOverride(
  webview: Frame,
  credentialStatus: { hasCredentials: boolean; email: string; source: 'env' | 'keychain' | 'none' },
): Promise<void> {
  await sendE2eBridgeCommand(webview, {
    action: 'SET_CREDENTIAL_STATUS_OVERRIDE',
    payload: { credentialStatus },
  });
}

async function clearCredentialStatusOverride(webview: Frame): Promise<void> {
  await sendE2eBridgeCommand(webview, { action: 'CLEAR_CREDENTIAL_STATUS_OVERRIDE' });
}

async function refreshCredentialStatus(webview: Frame): Promise<void> {
  await postExtensionMessage(webview, { type: 'GET_CREDENTIALS_STATUS' });
}

async function startPackagesErrorMonitor(webview: Frame): Promise<void> {
  await startDomTextMonitor(webview, '__cdsDebugPackagesErrorMonitor', '.packages-error');
}

async function startErrorBoxMonitor(webview: Frame): Promise<void> {
  await startDomTextMonitor(webview, '__cdsDebugErrorBoxMonitor', '.error-box');
}

async function startDomTextMonitor(webview: Frame, key: string, selector: string): Promise<void> {
  await webview.evaluate(({ key: monitorKey, selector: monitorSelector }) => {
    type DomTextMonitor = {
      events: string[];
      observer?: MutationObserver;
    };

    const monitorWindow = window as Window & Record<string, DomTextMonitor | undefined>;
    monitorWindow[monitorKey]?.observer?.disconnect();

    const events: string[] = [];
    const capture = (): void => {
      const messages = Array.from(document.querySelectorAll(monitorSelector))
        .map((node) => node.textContent?.trim() ?? '')
        .filter(Boolean);
      for (const message of messages) {
        events.push(message);
      }
    };

    const observer = new MutationObserver(() => {
      capture();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    capture();
    monitorWindow[monitorKey] = { events, observer };
  }, { key, selector });
}

async function readPackagesErrorEvents(webview: Frame): Promise<string[]> {
  return readDomTextMonitorEvents(webview, '__cdsDebugPackagesErrorMonitor');
}

async function readErrorBoxEvents(webview: Frame): Promise<string[]> {
  return readDomTextMonitorEvents(webview, '__cdsDebugErrorBoxMonitor');
}

async function readDomTextMonitorEvents(webview: Frame, key: string): Promise<string[]> {
  return webview.evaluate((monitorKey) => {
    type DomTextMonitor = {
      events: string[];
      observer?: MutationObserver;
    };

    const monitorWindow = window as Window & Record<string, DomTextMonitor | undefined>;
    return monitorWindow[monitorKey]?.events.slice() ?? [];
  }, key);
}

async function stopPackagesErrorMonitor(webview: Frame): Promise<string[]> {
  return stopDomTextMonitor(webview, '__cdsDebugPackagesErrorMonitor');
}

async function stopErrorBoxMonitor(webview: Frame): Promise<string[]> {
  return stopDomTextMonitor(webview, '__cdsDebugErrorBoxMonitor');
}

async function stopDomTextMonitor(webview: Frame, key: string): Promise<string[]> {
  const events = await readDomTextMonitorEvents(webview, key);
  await webview.evaluate((monitorKey) => {
    type DomTextMonitor = {
      events: string[];
      observer?: MutationObserver;
    };

    const monitorWindow = window as Window & Record<string, DomTextMonitor | undefined>;
    monitorWindow[monitorKey]?.observer?.disconnect();
    delete monitorWindow[monitorKey];
  }, key);
  return events;
}

async function completeMappingToReadyWithFolder(webview: Frame, folderPath: string): Promise<void> {
  await goToFolderSelection(webview);
  await injectSelectedFolder(webview, folderPath);
  await expect(webview.getByText(folderPath)).toBeVisible();
  await webview.locator('#btn-save-mapping').click();
  await expectReadyScreen(webview);
}

async function completeMappingToReady(webview: Frame): Promise<void> {
  await completeMappingToReadyWithFolder(webview, MOCK_GROUP_FOLDER);
}

async function startDebugForApp(webview: Frame, appName: string): Promise<void> {
  await webview.locator(`input[type="checkbox"][data-app="${appName}"]`).check();
  await expectButtonEnabled(webview.locator('#btn-start-debug'));
  await webview.locator('#btn-start-debug').click();
}

async function openBreakpointSnapshotsScreen(webview: Frame): Promise<void> {
  await webview.locator('#btn-open-breakpoint-snapshots').click();
  await expect(webview.locator('.step-title')).toContainText('Breakpoint Snapshots');
  await expect(webview.locator('#btn-back-breakpoint-snapshots')).toBeVisible();
}

async function enableBreakpointSnapshotHandlingFromSettings(webview: Frame): Promise<void> {
  await webview.locator('#btn-gear').click();
  await expect(webview.getByText('Settings')).toBeVisible();
  const toggle = webview.locator('#chk-breakpoint-snapshot-handling');
  if (!(await toggle.isChecked())) {
    await toggle.check({ force: true });
    await delay(300);
  }
  await webview.locator('#btn-back-settings').click();
  await expectReadyScreen(webview);
  await expect(webview.locator('#btn-open-breakpoint-snapshots')).toBeVisible();
}

async function expectButtonDisabled(button: Locator): Promise<void> {
  await expect(button).toBeDisabled();
}

async function expectButtonEnabled(button: Locator): Promise<void> {
  await expect(button).toBeEnabled();
}

async function readCssProperty(locator: Locator, propertyName: string): Promise<string> {
  return locator.evaluate((element, property) => window.getComputedStyle(element).getPropertyValue(property).trim(), propertyName);
}

function createFixtureSourcePath(
  packageName: string,
  relativePath: string,
  version = '1.0.0',
  rootDir = '/workspace',
): string {
  if (packageName.startsWith('@')) {
    const encoded = packageName.replace('/', '+');
    return join(rootDir, 'node_modules', '.pnpm', `${encoded}@${version}`, 'node_modules', packageName, relativePath);
  }
  return join(rootDir, 'node_modules', packageName, relativePath);
}

function normalizeFixturePackageFile(
  file: string | { relativePath: string; content: string },
): { relativePath: string; content?: string } {
  if (typeof file === 'string') {
    return { relativePath: file };
  }
  return file;
}

function createFixtureFolderBuilder(name: string, path: string): FixtureFolderBuilder {
  return {
    name,
    path,
    folders: new Map<string, FixtureFolderBuilder>(),
    files: [],
  };
}

function insertFixtureFile(root: FixtureFolderBuilder, file: FixturePackageFile): void {
  const segments = file.relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) return;

  let cursor = root;
  for (const segment of segments) {
    const nextPath = cursor.path ? `${cursor.path}/${segment}` : segment;
    const nextFolder = cursor.folders.get(segment) ?? createFixtureFolderBuilder(segment, nextPath);
    cursor.folders.set(segment, nextFolder);
    cursor = nextFolder;
  }

  cursor.files.push(file);
}

function buildFixtureTree(packageId: string, files: FixturePackageFile[]): Record<string, unknown>[] {
  const root = createFixtureFolderBuilder('', '');
  for (const file of files) {
    insertFixtureFile(root, file);
  }

  const toNodes = (builder: FixtureFolderBuilder): Record<string, unknown>[] => {
    const folderNodes = Array.from(builder.folders.values())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((folder) => ({
        id: `folder:${packageId}:${folder.path}`,
        kind: 'folder',
        name: folder.name,
        path: folder.path,
        children: toNodes(folder),
      }));

    const fileNodes = builder.files
      .slice()
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((file) => ({
        id: file.id,
        kind: 'file',
        name: file.relativePath.split('/').pop() ?? file.relativePath,
        path: file.relativePath,
        file,
      }));

    return [...folderNodes, ...fileNodes];
  };

  return toNodes(root);
}

function createPackageFixture(spec: FixturePackageSpec): Record<string, unknown> {
  const files = spec.files.map((file) => {
    const relativePath = normalizeFixturePackageFile(file).relativePath;
    const fileName = relativePath.split('/').pop() ?? relativePath;
    return {
      id: `${spec.name}:${relativePath}`,
      label: relativePath,
      relativePath,
      source: {
        name: fileName,
        path: createFixtureSourcePath(spec.name, relativePath, spec.version),
      },
    };
  });

  return {
    id: spec.name,
    name: spec.name,
    displayName: spec.version ? `${spec.name}@${spec.version}` : spec.name,
    files,
    tree: buildFixtureTree(spec.name, files),
  };
}

async function createPackageFixtureInWorkspace(
  workspaceDir: string,
  spec: FixturePackageSpec,
  options?: { reportedRootDir?: string },
): Promise<Record<string, unknown>> {
  const files = await Promise.all(spec.files.map(async (file) => {
    const normalizedFile = normalizeFixturePackageFile(file);
    const relativePath = normalizedFile.relativePath;
    const absolutePath = createFixtureSourcePath(spec.name, relativePath, spec.version, workspaceDir);
    const reportedPath = createFixtureSourcePath(
      spec.name,
      relativePath,
      spec.version,
      options?.reportedRootDir ?? workspaceDir,
    );
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      normalizedFile.content ?? `// ${spec.name} :: ${relativePath}\n`,
      'utf8',
    );
    return {
      id: `${spec.name}:${relativePath}`,
      label: relativePath,
      relativePath,
      source: {
        name: relativePath.split('/').pop() ?? relativePath,
        path: reportedPath,
      },
    };
  }));

  return {
    id: spec.name,
    name: spec.name,
    displayName: spec.version ? `${spec.name}@${spec.version}` : spec.name,
    files,
    tree: buildFixtureTree(spec.name, files),
  };
}

async function expectEditorCursorPosition(workbenchPage: Page, line: number, column: number): Promise<void> {
  await expect(workbenchPage.getByText(new RegExp(`Ln\\s+${line},\\s+Col\\s+${column}`))).toBeVisible({ timeout: 10_000 });
}

async function positionPackageTreeRow(
  webview: Frame,
  rowSelector: string,
  rowText: string,
  offsetFromTop: number,
): Promise<void> {
  await webview.locator('.packages-tree').evaluate((treeElement, args) => {
    const tree = treeElement as HTMLElement;
    const rows = Array.from(tree.querySelectorAll(args.rowSelector));
    const target = rows.find((row) => row.textContent?.includes(args.rowText)) as HTMLElement | undefined;
    if (!target) throw new Error(`Row not found: ${args.rowText}`);
    const treeRect = tree.getBoundingClientRect();
    const rowRect = target.getBoundingClientRect();
    tree.scrollTop += (rowRect.top - treeRect.top) - args.offsetFromTop;
  }, { rowSelector, rowText, offsetFromTop });
}

async function readPackageTreeRowMetrics(
  webview: Frame,
  rowSelector: string,
  rowText: string,
): Promise<{ scrollTop: number; rowTop: number; rowBottom: number; clientHeight: number }> {
  return webview.locator('.packages-tree').evaluate((treeElement, args) => {
    const tree = treeElement as HTMLElement;
    const rows = Array.from(tree.querySelectorAll(args.rowSelector));
    const target = rows.find((row) => row.textContent?.includes(args.rowText)) as HTMLElement | undefined;
    if (!target) throw new Error(`Row not found: ${args.rowText}`);
    const treeRect = tree.getBoundingClientRect();
    const rowRect = target.getBoundingClientRect();
    return {
      scrollTop: tree.scrollTop,
      rowTop: rowRect.top - treeRect.top,
      rowBottom: rowRect.bottom - treeRect.top,
      clientHeight: tree.clientHeight,
    };
  }, { rowSelector, rowText });
}

test.describe('Launch.json Cleanup E2E', () => {
  test('User can reopen VS Code and stale CDS launch configs are cleaned while manual configs are kept', async () => {
    const workspaceDir = await createWorkspaceWithLaunchJson([
      {
        name: 'Debug: stale-managed-legacy',
        type: 'node',
        request: 'attach',
        address: '127.0.0.1',
        port: 20000,
        localRoot: '/tmp/stale',
        sourceMaps: true,
        restart: true,
        skipFiles: ['<node_internals>/**'],
        outFiles: ['/tmp/stale/gen/srv/**/*.js'],
      },
      {
        name: 'CDS Managed Marker',
        type: 'node',
        request: 'attach',
        address: '127.0.0.1',
        port: 20001,
        localRoot: '/tmp/stale-2',
        sourceMaps: true,
        restart: true,
        skipFiles: ['<node_internals>/**'],
        outFiles: ['/tmp/stale-2/gen/srv/**/*.js'],
        cdsDebugManaged: true,
      },
      {
        name: 'Debug: manual-launch',
        type: 'node',
        request: 'launch',
        program: '${workspaceFolder}/server.js',
      },
      {
        name: 'Manual config',
        type: 'node',
        request: 'launch',
        program: '${workspaceFolder}/index.js',
      },
    ]);

    try {
      await withVsCodeSession(
        { credentialMode: 'env', cfScenario: 'success' },
        async (workbenchPage) => {
          await openCdsDebugWebview(workbenchPage);

          await expect.poll(
            async () => {
              const launch = await readLaunchJson(workspaceDir);
              return launch.configurations.map((c) => String(c.name ?? ''));
            },
            { timeout: 15_000 },
          ).toEqual(['Debug: manual-launch', 'Manual config']);
        },
        workspaceDir,
      );
    } finally {
      await removeDirWithRetry(workspaceDir);
    }
  });
});

test.describe('CAP Debug Config Precedence E2E', () => {
  test('User setting overrides workspace cap config when generating launch.json', async () => {
    const workspaceDir = await createWorkspaceForCapConfigTest({
      workspaceConfig: { remoteRoot: '/sample/workspace-root' },
    });

    try {
      await withVsCodeSession(
        {
          credentialMode: 'env',
          cfScenario: 'success',
          userSettings: {
            'cdsDebug.sharedCapDebugConfig': {
              remoteRoot: '/sample/global-root',
            },
          },
        },
        async (workbenchPage) => {
          const webview = await openCdsDebugWebview(workbenchPage);
          await completeMappingToReadyWithFolder(webview, workspaceDir);
          await startDebugForApp(webview, 'mock-service-a');

          await expect.poll(
            async () => {
              try {
                const launchJson = await readLaunchJson(workspaceDir);
                return launchJson.configurations
                  .filter((item) => item.name === 'Debug: mock-service-a')
                  .map((item) => ({
                    cdsDebugManaged: item.cdsDebugManaged,
                    remoteRoot: item.remoteRoot,
                  }));
              } catch {
                return [];
              }
            },
            { timeout: 15_000 },
          ).toEqual([
            {
              cdsDebugManaged: true,
              remoteRoot: '/sample/global-root',
            },
          ]);
        },
        workspaceDir,
      );
    } finally {
      await removeDirWithRetry(workspaceDir);
    }
  });

  test('Workspace cap config is used when no user setting is configured', async () => {
    const workspaceDir = await createWorkspaceForCapConfigTest({
      workspaceConfig: { remoteRoot: '/sample/workspace-root' },
    });

    try {
      await withVsCodeSession(
        { credentialMode: 'env', cfScenario: 'success' },
        async (workbenchPage) => {
          const webview = await openCdsDebugWebview(workbenchPage);
          await completeMappingToReadyWithFolder(webview, workspaceDir);
          await startDebugForApp(webview, 'mock-service-a');

          await expect.poll(
            async () => {
              try {
                const launchJson = await readLaunchJson(workspaceDir);
                return launchJson.configurations
                  .filter((item) => item.name === 'Debug: mock-service-a')
                  .map((item) => ({
                    cdsDebugManaged: item.cdsDebugManaged,
                    remoteRoot: item.remoteRoot,
                  }));
              } catch {
                return [];
              }
            },
            { timeout: 15_000 },
          ).toEqual([
            {
              cdsDebugManaged: true,
              remoteRoot: '/sample/workspace-root',
            },
          ]);
        },
        workspaceDir,
      );
    } finally {
      await removeDirWithRetry(workspaceDir);
    }
  });

  test('Per-service cap config overrides both user setting and workspace fallback', async () => {
    const workspaceDir = await createWorkspaceForCapConfigTest({
      workspaceConfig: { remoteRoot: '/sample/workspace-root' },
      serviceConfig: { remoteRoot: '/sample/service-root' },
    });

    try {
      await withVsCodeSession(
        {
          credentialMode: 'env',
          cfScenario: 'success',
          userSettings: {
            'cdsDebug.sharedCapDebugConfig': {
              remoteRoot: '/sample/global-root',
            },
          },
        },
        async (workbenchPage) => {
          const webview = await openCdsDebugWebview(workbenchPage);
          await completeMappingToReadyWithFolder(webview, workspaceDir);
          await startDebugForApp(webview, 'mock-service-a');

          await expect.poll(
            async () => {
              try {
                const launchJson = await readLaunchJson(workspaceDir);
                return launchJson.configurations
                  .filter((item) => item.name === 'Debug: mock-service-a')
                  .map((item) => ({
                    cdsDebugManaged: item.cdsDebugManaged,
                    remoteRoot: item.remoteRoot,
                  }));
              } catch {
                return [];
              }
            },
            { timeout: 15_000 },
          ).toEqual([
            {
              cdsDebugManaged: true,
              remoteRoot: '/sample/service-root',
            },
          ]);
        },
        workspaceDir,
      );
    } finally {
      await removeDirWithRetry(workspaceDir);
    }
  });

  test('Malformed user setting falls back to workspace cap config', async () => {
    const workspaceDir = await createWorkspaceForCapConfigTest({
      workspaceConfig: { remoteRoot: '/sample/workspace-root' },
    });

    try {
      await withVsCodeSession(
        {
          credentialMode: 'env',
          cfScenario: 'success',
          userSettings: {
            'cdsDebug.sharedCapDebugConfig': {
              remoteRoot: 123,
            },
          },
        },
        async (workbenchPage) => {
          const webview = await openCdsDebugWebview(workbenchPage);
          await completeMappingToReadyWithFolder(webview, workspaceDir);
          await startDebugForApp(webview, 'mock-service-a');

          await expect.poll(
            async () => {
              try {
                const launchJson = await readLaunchJson(workspaceDir);
                return launchJson.configurations
                  .filter((item) => item.name === 'Debug: mock-service-a')
                  .map((item) => ({
                    cdsDebugManaged: item.cdsDebugManaged,
                    remoteRoot: item.remoteRoot,
                  }));
              } catch {
                return [];
              }
            },
            { timeout: 15_000 },
          ).toEqual([
            {
              cdsDebugManaged: true,
              remoteRoot: '/sample/workspace-root',
            },
          ]);
        },
        workspaceDir,
      );
    } finally {
      await removeDirWithRetry(workspaceDir);
    }
  });
});

test.describe('CDS Debug Onboarding and Launcher E2E', () => {
  test('User can login and see mocked org list', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);
      // Default region eu10 shows its endpoint URL below the region cards
      await expect(webview.locator('.radio-desc', { hasText: 'api.cf.eu10.hana.ondemand.com' })).toBeVisible();
      await startErrorBoxMonitor(webview);
      await goToOrgSelection(webview);

      // Verify all SELECT_ORG screen structural elements
      await expect(webview.locator('.step-badge', { hasText: '2/3' })).toBeVisible();
      await expect(webview.locator('.info-box', { hasText: 'Choose the Cloud Foundry org you want to debug.' })).toBeVisible();
      await expect(webview.locator('.section-label', { hasText: 'CF Org' })).toBeVisible();
      // Next button disabled until an org is selected
      await expect(webview.locator('#btn-next-org')).toBeDisabled();
      await expect(webview.locator('#btn-back-region')).toBeVisible();
      // Each org is rendered as an .org-item label with a radio input
      await expect(webview.locator('.org-item', { hasText: 'mock-org-alpha' })).toBeVisible();
      await expect(webview.locator('.org-item', { hasText: 'mock-org-beta' })).toBeVisible();
      await expect(webview.locator('input[name="cf-org"][value="mock-org-alpha"]')).toBeAttached();
      await expect(webview.locator('input[name="cf-org"][value="mock-org-beta"]')).toBeAttached();
      await expect(webview.locator('.error-box')).toHaveCount(0);
      await expect(webview.locator('#btn-login')).toHaveCount(0);
      await expect(webview.locator('#btn-save-creds')).toHaveCount(0);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can keep org search hidden until synced topology is ready', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await injectMessage(webview, {
        type: 'CF_TOPOLOGY',
        payload: { ready: false, accounts: [] },
      });

      await expect(webview.locator('#org-search-input')).toHaveCount(0);
      await expect(webview.locator('.org-search-row')).toHaveCount(0);
      await expect(webview.getByText('Select Region')).toBeVisible();
      await expect(webview.getByRole('button', { name: 'Login to Cloud Foundry' })).toBeVisible();
    });
  });

  test('User can search a synced org across regions and continue after confirming', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);
      await expect(webview.locator('#org-search-input')).toHaveCount(0);
      await startErrorBoxMonitor(webview);

      await injectMessage(webview, {
        type: 'CF_TOPOLOGY',
        payload: {
          ready: true,
          accounts: [
            {
              regionKey: 'eu10',
              regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
              apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
              orgName: 'mock-org-alpha',
              spaces: ['app'],
            },
            {
              regionKey: 'us10',
              regionLabel: 'US East (VA) - AWS (us10)',
              apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
              orgName: 'mock-org-beta',
              spaces: ['app'],
            },
          ],
        },
      });

      await expect(webview.getByText('Search org (across regions)')).toBeVisible();
      await expect(webview.getByRole('tab', { name: 'Org' })).toHaveAttribute('aria-selected', 'true');
      await expect(webview.getByRole('tab', { name: 'Region' })).toBeVisible();
      await expect(webview.getByText('Select Region')).toHaveCount(0);
      await webview.locator('#org-search-input').fill('beta');
      await expect(webview.getByRole('button', { name: /mock-org-beta/ })).toBeVisible();
      await expect(webview.getByRole('button', { name: /mock-org-alpha/ })).toHaveCount(0);
      await captureStepEvidence(workbenchPage, 'org-search-synced-results');

      await webview.getByRole('button', { name: /mock-org-beta/ }).click();
      await expect(webview.locator('.step-badge', { hasText: '1/3' })).toBeVisible();
      await expect(webview.getByText('Select Local Folder')).toHaveCount(0);
      await expect(webview.locator('#btn-login')).toBeEnabled();
      await captureStepEvidence(workbenchPage, 'org-search-staged-selection');

      await webview.locator('#btn-login').click();
      await expect(webview.getByText('Select Local Folder')).toBeVisible({ timeout: 15_000 });
      await expect(webview.locator('.step-badge', { hasText: '3/3' })).toBeVisible();
      await expect(webview.locator('.info-box', { hasText: 'mock-org-beta' })).toBeVisible();
      await expect(webview.locator('.info-box', { hasText: 'app' })).toBeVisible();
      await expect(webview.getByText('Select CF Org')).toHaveCount(0);
      await expect(webview.locator('#btn-save-mapping')).toBeDisabled();
      await captureStepEvidence(workbenchPage, 'org-search-folder-shortcut');

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can switch to region fallback and filter regions after synced topology is ready', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await injectMessage(webview, {
        type: 'CF_TOPOLOGY',
        payload: {
          ready: true,
          accounts: [{
            regionKey: 'us10',
            regionLabel: 'US East (VA) - AWS (us10)',
            apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
            orgName: 'mock-org-beta',
            spaces: ['app'],
          }],
        },
      });

      await webview.getByRole('tab', { name: 'Region' }).click();
      await expect(webview.getByRole('tab', { name: 'Region' })).toHaveAttribute('aria-selected', 'true');
      await expect(webview.getByText('Select Region')).toBeVisible();
      const regionSearch = webview.getByLabel('Search regions');
      const regionList = webview.getByRole('radiogroup', { name: 'Cloud Foundry regions' });
      await expect(regionSearch).toBeVisible();
      await expect.poll(async () => regionList.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

      await regionSearch.fill('us west');
      await expect(webview.locator('.region-card', { hasText: 'us20' })).toBeVisible();
      await expect(webview.locator('.region-card', { hasText: 'eu10' })).toHaveCount(0);

      await regionSearch.fill('china');
      await expect(webview.locator('.region-card', { hasText: 'cn40' })).toBeVisible();
      await expect(webview.locator('.region-card', { hasText: 'cn20' })).toBeVisible();
      await webview.locator('.region-card', { hasText: 'cn40' }).click();
      await expect(webview.locator('.radio-desc', { hasText: 'api.cf.cn40.platform.sapcloud.cn' })).toBeVisible();

      await expect(webview.getByRole('button', { name: 'Login to Cloud Foundry' })).toBeEnabled();
      await captureStepEvidence(workbenchPage, 'region-tab-filtered-results');
    });
  });

  test('User can see setup screen when credentials are missing', async () => {
    await withVsCodeSession({ credentialMode: 'none', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await startErrorBoxMonitor(webview);
      await expectSetupCredentialsScreen(webview);
      // Setup mode: env-var hint shown, no "Back to Settings" button
      await expect(webview.locator('.cred-env-hint')).toBeVisible();
      await expect(webview.locator('.cred-env-hint')).toContainText('SAP_EMAIL');
      await expect(webview.locator('.cred-env-hint')).toContainText('SAP_PASSWORD');
      await expect(webview.locator('#btn-cancel-creds')).toHaveCount(0);
      await expect(webview.locator('.error-box')).toHaveCount(0);
      await expect(webview.locator('.step-title', { hasText: 'CF Region' })).toHaveCount(0);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can see setup credential validation errors', async () => {
    await withVsCodeSession({ credentialMode: 'none', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectSetupCredentialsScreen(webview);

      const saveButton = webview.getByRole('button', { name: /Save & Continue|Update & Continue/ });

      await saveButton.click();
      await expect(webview.getByText('Email is required.')).toBeVisible();
      await expect(webview.locator('.step-title', { hasText: 'Setup Credentials' })).toBeVisible();
      await expect(saveButton).toBeEnabled();

      await webview.getByPlaceholder('your.name@company.com').fill('invalid-email');
      await saveButton.click();
      await expect(webview.getByText('Please enter a valid email address.')).toBeVisible();
      await expect(webview.locator('.step-title', { hasText: 'Setup Credentials' })).toBeVisible();
      await expect(saveButton).toBeEnabled();

      await webview.getByPlaceholder('your.name@company.com').fill('valid.user@example.com');
      await saveButton.click();
      await expect(webview.getByText('Password is required.')).toBeVisible();
      await expect(webview.locator('.step-title', { hasText: 'Setup Credentials' })).toBeVisible();
      await expect(webview.locator('#btn-login')).toHaveCount(0);
      await expect(webview.locator('#search-input')).toHaveCount(0);
      await expect(saveButton).toBeEnabled();
    });
  });

  test('User can see non-https endpoint validation error', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      // Select the custom endpoint card — UI swaps endpoint radio-desc for a text input
      await webview.locator('input[name="cf-region"][value="custom"]').check({ force: true });
      await expect(webview.locator('#api-endpoint-custom')).toBeVisible();
      await expect(webview.locator('.radio-desc', { hasText: 'Enter your full CF API URL' })).toBeVisible();
      // Standard eu10 endpoint text is gone when custom is selected
      await expect(webview.locator('.radio-desc', { hasText: 'api.cf.eu10.hana.ondemand.com' })).toHaveCount(0);

      await webview.locator('#api-endpoint-custom').fill('http://api.cf.invalid.hana.ondemand.com');

      await loginFromRegionScreen(webview);
      await expect(webview.getByText('API endpoint must start with https://')).toBeVisible();
      await expectRegionScreen(webview);
      await expect(webview.locator('#api-endpoint-custom')).toBeVisible();
      await expect(webview.locator('#api-endpoint-custom')).toHaveValue('http://api.cf.invalid.hana.ondemand.com');
      await expect(webview.locator('#btn-cancel-login')).toHaveCount(0);
      await expect(webview.getByText('Logging in…')).toHaveCount(0);
    });
  });

  test('User can login with a valid custom endpoint', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await webview.locator('input[name="cf-region"][value="custom"]').check({ force: true });
      await webview.locator('#api-endpoint-custom').fill('https://api.cf.us10.hana.ondemand.com');

      await startErrorBoxMonitor(webview);
      await loginFromRegionScreen(webview);
      await expect(webview.getByText('Select CF Org')).toBeVisible();
      await expect(webview.getByText('mock-org-alpha')).toBeVisible();
      await expect(webview.locator('.error-box')).toHaveCount(0);
      await expect(webview.locator('#btn-login')).toHaveCount(0);
      await expect(webview.locator('#api-endpoint-custom')).toHaveCount(0);
      await expect(webview.locator('#btn-cancel-login')).toHaveCount(0);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can see login error when CF auth fails', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'auth-fail' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await loginFromRegionScreen(webview);
      await expect(webview.getByText(/mock auth failed|Command failed|authentication failed/i)).toBeVisible();
      await expectRegionScreen(webview);
      await expect(webview.locator('.error-box')).toHaveCount(1);
      await expect(webview.locator('.spinner')).toHaveCount(0);
      await expect(webview.locator('#btn-cancel-login')).toHaveCount(0);
      await expect(webview.getByText('Logging in…')).toHaveCount(0);
    });
  });

  test('User can cancel login and return to region screen', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-auth' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await startErrorBoxMonitor(webview);
      await loginFromRegionScreen(webview);
      // Verify all LOGGING_IN screen elements: spinner, heading, endpoint URL, cancel button
      await expect(webview.locator('.spinner')).toBeVisible();
      await expect(webview.getByText(/Logging in/)).toBeVisible();
      await expect(webview.locator('.radio-desc', { hasText: 'api.cf.eu10.hana.ondemand.com' })).toBeVisible();
      await expect(webview.locator('#btn-cancel-login')).toBeVisible();
      await webview.locator('#btn-cancel-login').click();

      await expectRegionScreen(webview);
      await expect(webview.locator('.spinner')).toHaveCount(0);
      await expect(webview.getByText('Logging in…')).toHaveCount(0);
      await expect(webview.locator('#btn-cancel-login')).toHaveCount(0);
      await expect(webview.locator('.error-box')).toHaveCount(0);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('LOGGING_IN reconnecting variant shows different heading and no cancel button', async () => {
    // Trigger auto-reconnect: inject CONFIG_LOADED with saved mappings (sets isRestoringSession=true),
    // then immediately inject APPS_ERROR (simulates CF session expiry).
    // The slow-auth scenario keeps cf auth sleeping for 30 s so LOGGING_IN stays stable.
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-auth' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);
      await startErrorBoxMonitor(webview);

      // Inject CONFIG_LOADED with existing mappings → webview sets isRestoringSession=true,
      // transitions to LOADING_APPS, and sends LOAD_APPS to the extension.
      await injectMessage(webview, {
        type: 'CONFIG_LOADED',
        payload: {
          config: {
            apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
            orgs: ['mock-org-alpha'],
            orgGroupMappings: [{ cfOrg: 'mock-org-alpha', groupFolderPath: '/tmp/test' }],
          },
          credentialStatus: { hasCredentials: true, email: 'test@example.com', source: 'env' },
        },
      });
      await expect(webview.getByText(/Loading apps for/i)).toBeVisible();

      // Inject APPS_ERROR — isRestoringSession=true + apiEndpoint set → auto-reconnect:
      // state.isReconnecting=true, screen=LOGGING_IN, sends LOGIN (cf auth sleeps 30 s).
      await injectMessage(webview, {
        type: 'APPS_ERROR',
        payload: { message: 'CF session expired' },
      });

      // Reconnecting mode: spinner + different heading; endpoint URL shown; NO cancel button
      await expect(webview.locator('.spinner')).toBeVisible();
      await expect(webview.getByText(/Session expired. Reconnecting/i)).toBeVisible();
      await expect(webview.locator('.radio-desc', { hasText: 'api.cf.eu10.hana.ondemand.com' })).toBeVisible();
      await expect(webview.locator('#btn-cancel-login')).toHaveCount(0);
      await expect(webview.getByText('Logging in…')).toHaveCount(0);
      await expect(webview.getByText(/Loading apps for/i)).toHaveCount(0);
      await expect(webview.locator('.error-box')).toHaveCount(0);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can see empty-org state when org list is empty', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'no-orgs' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await goToOrgSelection(webview);

      const nextButton = webview.locator('#btn-next-org');
      await expect(webview.getByText('No orgs found.')).toBeVisible();
      await expect(webview.locator('.org-item')).toHaveCount(0);
      await expect(webview.locator('.error-box')).toHaveCount(0);
      await expectButtonDisabled(nextButton);
      await expect(webview.locator('#btn-back-region')).toBeVisible();

      await webview.locator('#btn-back-region').click();
      await expectRegionScreen(webview);
    });
  });

  test('User can navigate org selection and go back to region', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);
      await startErrorBoxMonitor(webview);

      await loginFromRegionScreen(webview);
      await expect(webview.getByText('Select CF Org')).toBeVisible();
      await expect(webview.locator('#btn-back-region')).toBeVisible();
      await expect(webview.locator('#btn-next-org')).toBeDisabled();
      await expect(webview.locator('#btn-back-select-org')).toHaveCount(0);

      await webview.locator('input[name="cf-org"][value="mock-org-beta"]').check({ force: true });
      // Surgical DOM update: selected org gets the "selected" CSS class on its label
      await expect(webview.locator('.org-item.selected', { hasText: 'mock-org-beta' })).toBeVisible();
      // Next button becomes enabled after an org is selected
      await expect(webview.locator('#btn-next-org')).toBeEnabled();
      await webview.locator('#btn-next-org').click();

      await expect(webview.getByText('Select Local Folder')).toBeVisible();
      await expect(webview.getByRole('button', { name: /Browse/i })).toBeVisible();
      await expect(webview.locator('#btn-back-region')).toHaveCount(0);

      await webview.locator('#btn-back-select-org').click();
      await expect(webview.getByText('Select CF Org')).toBeVisible();
      await expect(webview.locator('#btn-save-mapping')).toHaveCount(0);
      await expect(webview.locator('#btn-back-region')).toBeVisible();

      await webview.locator('#btn-back-region').click();
      await expectRegionScreen(webview);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can select a CF space when selected org has multiple spaces', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'multi-spaces' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await goToOrgSelection(webview);

      await webview.locator('input[name="cf-org"][value="mock-org-alpha"]').check({ force: true });
      await webview.locator('#btn-next-org').click();

      await expect(webview.getByText('Select CF Space')).toBeVisible();
      await expect(webview.locator('.step-badge', { hasText: '2/3' })).toBeVisible();
      await expect(webview.locator('.info-box', { hasText: 'mock-org-alpha' })).toBeVisible();
      await expect(webview.locator('.section-label', { hasText: 'CF Space' })).toBeVisible();
      await expect(webview.locator('input[name="cf-space"][value="app"]')).toBeAttached();
      await expect(webview.locator('input[name="cf-space"][value="dev"]')).toBeAttached();
      await expectButtonDisabled(webview.locator('#btn-next-space'));
      await captureStepEvidence(workbenchPage, 'multi-space-select-space');

      await webview.locator('input[name="cf-space"][value="dev"]').check({ force: true });
      await expect(webview.locator('.space-item.selected', { hasText: 'dev' })).toBeVisible();
      await expectButtonEnabled(webview.locator('#btn-next-space'));
      await webview.locator('#btn-next-space').click();

      await expect(webview.getByText('Select Local Folder')).toBeVisible();
      await expect(webview.locator('.info-box', { hasText: 'mock-org-alpha' })).toBeVisible();
      await expect(webview.locator('.info-box', { hasText: 'dev' })).toBeVisible();
      await captureStepEvidence(workbenchPage, 'multi-space-folder-selected');

      await webview.locator('#btn-back-select-org').click();
      await expect(webview.getByText('Select CF Space')).toBeVisible();
      await webview.locator('#btn-back-space-org').click();
      await expect(webview.getByText('Select CF Org')).toBeVisible();
    });
  });

  test('User can complete mapping flow and reach ready screen', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await completeMappingToReady(webview);
      await startErrorBoxMonitor(webview);

      // Verify all READY screen structural elements
      await expect(webview.locator('#search-input')).toBeVisible();
      await expect(webview.locator('#chk-select-all')).toBeVisible();
      await expectButtonDisabled(webview.locator('#btn-start-debug'));
      await expect(webview.locator('#btn-refresh-apps')).toBeVisible();
      await expect(webview.locator('#btn-gear')).toBeVisible();
      await expect(webview.locator('#btn-remap')).toBeVisible();
      // Cloud Foundry info section is always present
      await expect(webview.locator('.section-label', { hasText: 'Cloud Foundry' })).toBeVisible();
      // No active sessions on first load
      await expect(webview.locator('.active-card')).toHaveCount(0);
      // Footer: nothing selected initially, 2 started apps available
      await expect(webview.locator('.footer-info')).toContainText('0 / 2 selected');
      // Select-all row shows count of selectable started apps
      await expect(webview.locator('.select-all-row span')).toContainText('Select all started (2)');
      // No error box on successful load
      await expect(webview.locator('.error-box')).toHaveCount(0);
      // SR-only live region for screen-reader announcements is always present
      await expect(webview.locator('.sr-only[aria-live="polite"]')).toBeAttached();
      await expect(webview.getByText('mock-service-a')).toBeVisible();
      await expect(webview.getByText('mock-service-b')).toBeVisible();
      await expect(webview.getByText('mock-service-c')).toBeVisible();
      await expect(webview.locator('#btn-save-mapping')).toHaveCount(0);
      await expect(webview.locator('#btn-back-region')).toHaveCount(0);
      await expect(webview.getByText('Settings')).toHaveCount(0);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can filter and select started apps in ready screen', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await completeMappingToReady(webview);
      await startErrorBoxMonitor(webview);

      const startButton = webview.locator('#btn-start-debug');
      await expectButtonDisabled(startButton);

      await webview.locator('#chk-select-all').check();
      await expectButtonEnabled(startButton);
      await expect(webview.getByText('2 / 2 selected')).toBeVisible();
      // When all started apps are selected the label flips to "Deselect all"
      await expect(webview.locator('.select-all-row span')).toContainText('Deselect all');

      await webview.locator('#search-input').fill('mock-service-c');
      await expect(webview.locator('.app-name', { hasText: 'mock-service-c' })).toHaveCount(1);
      await expect(webview.locator('.app-name', { hasText: 'mock-service-a' })).toHaveCount(0);
      await expect(webview.locator('.app-name', { hasText: 'mock-service-b' })).toHaveCount(0);

      await webview.locator('#chk-select-all').uncheck();
      await expectButtonDisabled(startButton);

      // Search for a name that matches no app → "No apps found" empty state
      await webview.locator('#search-input').fill('zzz-nonexistent-app');
      await expect(webview.locator('.app-list')).toContainText('No apps found');

      // Individual checkbox selection (not via select-all)
      await webview.locator('#search-input').fill('');
      await webview.locator('input[type="checkbox"][data-app="mock-service-a"]').check();
      await expect(webview.locator('.footer-info')).toContainText('1 / 2 selected');
      await expectButtonEnabled(startButton);
      await webview.locator('input[type="checkbox"][data-app="mock-service-a"]').uncheck();
      await expect(webview.locator('.footer-info')).toContainText('0 / 2 selected');
      await expectButtonDisabled(startButton);
      // Active sessions panel is present (empty by default)
      await expect(webview.locator('#active-sessions-panel')).toBeAttached();
      await expect(webview.locator('.active-card')).toHaveCount(0);
      await expect(webview.locator('#btn-retry-apps')).toHaveCount(0);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can see apps-load error and retry affordance', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'apps-fail' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await goToFolderSelection(webview);
      await injectSelectedFolder(webview, MOCK_GROUP_FOLDER);

      await webview.locator('#btn-save-mapping').click();
      await expect(webview.locator('.error-box')).toContainText(/mock apps load failed|Command failed/i);
      // Retry button uses the specific #btn-retry-apps ID
      await expect(webview.locator('#btn-retry-apps')).toBeVisible();
      await expect(webview.locator('#search-input')).toBeVisible();
      await expect(webview.locator('.spinner')).toHaveCount(0);
      await expect(webview.locator('.active-card')).toHaveCount(0);
      await expectButtonDisabled(webview.locator('#btn-start-debug'));
    });
  });

  test('User can cancel in-progress app loading and return to folder screen', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-apps' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await goToFolderSelection(webview);
      await injectSelectedFolder(webview, MOCK_GROUP_FOLDER);
      await startErrorBoxMonitor(webview);

      await webview.locator('#btn-save-mapping').click();
      await expect(webview.getByText(/Loading apps for/i)).toBeVisible();
      // Verify all LOADING_APPS screen elements: spinner and cancel button
      await expect(webview.locator('.spinner')).toBeVisible();
      // Org name is rendered in bold inside the loading message
      await expect(webview.locator('strong', { hasText: 'mock-org-alpha' })).toBeVisible();
      await expect(webview.locator('#btn-cancel-load-apps')).toBeVisible();
      await webview.locator('#btn-cancel-load-apps').click();

      await expect(webview.getByText('Select Local Folder')).toBeVisible();
      await expect(webview.getByRole('button', { name: /Save & Continue/i })).toBeVisible();
      await expect(webview.locator('.spinner')).toHaveCount(0);
      await expect(webview.locator('#btn-cancel-load-apps')).toHaveCount(0);
      await expect(webview.locator('.error-box')).toHaveCount(0);

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  test('User can open settings from ready and logout back to region', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await completeMappingToReady(webview);

      await webview.locator('#btn-gear').click();
      await expect(webview.getByText('Settings')).toBeVisible();
      await expect(webview.getByText('SAP Credentials')).toBeVisible();
      await expect(webview.locator('#chk-open-browser')).toBeVisible();
      await expect(webview.locator('#chk-breakpoint-snapshot-handling')).toBeVisible();
      await expect(webview.locator('#btn-back-settings')).toBeVisible();
      await expect(webview.locator('#btn-logout-settings')).toBeVisible();
      await expect(webview.locator('#search-input')).toHaveCount(0);
      await expect(webview.locator('#btn-start-debug')).toHaveCount(0);

      await webview.locator('#btn-logout-settings').click();
      await expectRegionScreen(webview);
    });
  });

  test('Clicking Start Debug Sessions shows pending sessions immediately (optimistic UI)', async () => {
    // Uses slow-target-after-apps so the initial LOAD_APPS flow stays fast, but the
    // subsequent Start Debug cfTarget() blocks long enough to assert optimistic UI
    // before DEBUG_CONNECTING arrives from the extension host.
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-target-after-apps' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await completeMappingToReady(webview);
      await startErrorBoxMonitor(webview);

      // Select all started apps and start debug
      await webview.locator('#chk-select-all').check();
      await expectButtonEnabled(webview.locator('#btn-start-debug'));
      await webview.locator('#btn-start-debug').click();

      // Active session cards must appear immediately — before the slow cfTarget()
      // network call in the extension completes — verifying optimistic UI behavior.
      await expect(webview.locator('.active-card')).toHaveCount(2, { timeout: 3_000 });
      await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();
      await expect(webview.locator('.active-card', { hasText: 'mock-service-c' })).toBeVisible();
      // PENDING state shows "Preparing…" spinner text
      await expect(
        webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.status-text-anim')
      ).toContainText('Preparing');
      await expect(webview.locator('[data-packages-app]')).toHaveCount(0);
      await expect(webview.locator('[data-retry-app]')).toHaveCount(0);

      // Apps should now be shown as disabled in the started list (no longer selectable)
      const serviceACheckbox = webview.locator('input[type="checkbox"][data-app="mock-service-a"]');
      const serviceCCheckbox = webview.locator('input[type="checkbox"][data-app="mock-service-c"]');
      await expect(serviceACheckbox).toBeDisabled({ timeout: 3_000 });
      await expect(serviceCCheckbox).toBeDisabled({ timeout: 3_000 });

      // Start button must be disabled since no more selectable started apps remain
      await expectButtonDisabled(webview.locator('#btn-start-debug'));
      await expect(webview.locator('.footer-info')).toContainText('No started apps');

      const errorBoxEvents = await stopErrorBoxMonitor(webview);
      expect(errorBoxEvents).toEqual([]);
    });
  });

  // ─── Ready Screen — App List and UI Details ────────────────────────────────

  test.describe('Ready Screen — App List and UI Details', () => {
    test('Stopped app has disabled checkbox and stopped badge', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // mock-service-b is stopped — checkbox must be disabled
        await expect(webview.locator('input[type="checkbox"][data-app="mock-service-b"]')).toBeDisabled();

        // The stopped app row carries a "stopped" badge and the "stopped" CSS class
        const stoppedRow = webview.locator('.app-row', { hasText: 'mock-service-b' });
        await expect(stoppedRow.locator('.badge-stopped')).toBeVisible();
        await expect(webview.locator('.app-row.stopped', { hasText: 'mock-service-b' })).toBeVisible();
        await expect(stoppedRow.locator('.badge-started')).toHaveCount(0);
        await expect(stoppedRow.locator('.badge-debug')).toHaveCount(0);
        await expect(stoppedRow.locator('[data-stop-app]')).toHaveCount(0);

        // App list shows both "Started" and "Stopped" section labels
        const appList = webview.locator('.app-list');
        await expect(appList.locator('.section-label', { hasText: 'Started' })).toBeVisible();
        await expect(appList.locator('.section-label', { hasText: 'Stopped' })).toBeVisible();
      });
    });

    test('CF info box shows region org and space values', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        const cfInfoBox = webview.locator('.cf-info-box');
        await expect(cfInfoBox.locator('.cf-info-label', { hasText: 'Region' })).toBeVisible();
        // Default selected region is eu10 — full display includes the region name
        const regionValue = cfInfoBox.locator('.cf-info-value').first();
        await expect(regionValue).toContainText('eu10');
        await expect(regionValue).toContainText('Europe (Frankfurt)');
        await expect(regionValue).toHaveAttribute('title', 'https://api.cf.eu10.hana.ondemand.com');
        await expect(cfInfoBox.locator('.cf-info-label', { hasText: 'Org' })).toBeVisible();
        await expect(cfInfoBox.locator('.cf-info-value', { hasText: 'mock-org-alpha' })).toBeVisible();
        await expect(cfInfoBox.locator('.cf-info-label', { hasText: 'Space' })).toBeVisible();
        await expect(cfInfoBox.locator('.cf-info-value', { hasText: 'app' })).toBeVisible();
        await expect(webview.locator('.error-box')).toHaveCount(0);
      });
    });

    test('Footer shows "No started apps" when all started apps have active sessions', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Initially 2 started apps are selectable
        await expect(webview.locator('.footer-info')).toContainText('0 / 2 selected');
        await expect(webview.locator('.select-all-row')).toBeVisible();

        // Put both started apps (mock-service-a, mock-service-c) into active sessions
        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: {
            appNames: ['mock-service-a', 'mock-service-c'],
            ports: { 'mock-service-a': 20000, 'mock-service-c': 20001 },
          },
        });

        // Footer switches to "No started apps" when no non-active started app remains
        await expect(webview.locator('.footer-info')).toContainText('No started apps', { timeout: 3_000 });
        await expect(webview.locator('.active-card')).toHaveCount(2, { timeout: 3_000 });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();
        await expect(webview.locator('.active-card', { hasText: 'mock-service-c' })).toBeVisible();
        // Select-all row stays in DOM (surgical update) but count drops to (0)
        await expect(webview.locator('.select-all-row span')).toContainText('(0)', { timeout: 3_000 });
        // Start button is disabled — no selectable apps remain
        await expectButtonDisabled(webview.locator('#btn-start-debug'));
      });
    });

    test('Active app shows debugging badge and disabled checkbox after session starts', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        const serviceARow = webview.locator('.app-row', { hasText: 'mock-service-a' });

        // Before session: shows "started" badge and selectable checkbox
        await expect(serviceARow.locator('.badge-started')).toBeVisible();
        await expect(webview.locator('input[type="checkbox"][data-app="mock-service-a"]')).toBeEnabled();

        // Inject a debug session for mock-service-a
        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });

        // After session: "debugging" badge, disabled checkbox, and "in-debug" CSS class on row
        await expect(serviceARow.locator('.badge-debug')).toBeVisible({ timeout: 3_000 });
        await expect(serviceARow.locator('.badge-started')).toHaveCount(0);
        await expect(webview.locator('input[type="checkbox"][data-app="mock-service-a"]')).toBeDisabled({ timeout: 3_000 });
        await expect(webview.locator('.app-row.in-debug', { hasText: 'mock-service-a' })).toBeVisible({ timeout: 3_000 });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible({ timeout: 3_000 });

        // Select-all count updates — only mock-service-c remains selectable
        await expect(webview.locator('.select-all-row span')).toContainText('(1)', { timeout: 3_000 });
      });
    });
  });

  // ─── Active Session Cards — Lifecycle via Injected Messages ────────────────

  test.describe('Active Session Cards — Lifecycle via Injected Messages', () => {
    test('DEBUG_CONNECTING creates a TUNNELING session card with spinner', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // No active sessions initially
        await expect(webview.locator('.active-card')).toHaveCount(0);

        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });

        // Card appears with app name and a spinner (TUNNELING state)
        await expect(webview.locator('.active-card')).toHaveCount(1, { timeout: 3_000 });
        const activeCard = webview.locator('.active-card', { hasText: 'mock-service-a' });
        await expect(activeCard).toBeVisible();
        // Card internal structure: .active-card-main > .active-card-title + .active-card-status
        await expect(activeCard.locator('.active-card-main')).toBeVisible();
        await expect(activeCard.locator('.active-card-title')).toContainText('mock-service-a');
        await expect(activeCard.locator('.active-card-port')).toContainText(':20000');
        await expect(activeCard.locator('.active-card-status')).toBeVisible();
        await expect(activeCard.locator('.active-card-status .spinner')).toBeVisible();
        await expect(activeCard.locator('.active-card-status .status-text-anim')).toBeVisible();
        await expect(activeCard.locator('[data-packages-app]')).toHaveCount(0);
        await expect(activeCard.locator('[data-retry-app]')).toHaveCount(0);
        // "Active Sessions" header label is shown above the cards
        await expect(webview.locator('.section-label', { hasText: 'Active Sessions' })).toBeVisible();
        // The stop button is always present on every card
        await expect(activeCard.locator('[data-stop-app="mock-service-a"]')).toBeVisible();
      });
    });

    test('APP_DEBUG_STATUS ATTACHED updates card to Debugger Attached', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-c'], ports: { 'mock-service-c': 20001 } },
        });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-c' })).toBeVisible();

        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-c', status: 'ATTACHED' },
        });

        const activeCard = webview.locator('.active-card', { hasText: 'mock-service-c' });
        await expect(activeCard.getByText('Debugger Attached')).toBeVisible({ timeout: 3_000 });
        // Spinner should be gone once attached
        await expect(activeCard.locator('.spinner')).toHaveCount(0, { timeout: 3_000 });
      });
    });

    test('APP_DEBUG_STATUS EXITED removes the session card and re-enables the app checkbox', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });
        await expect(webview.locator('.active-card')).toHaveCount(1, { timeout: 3_000 });

        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-a', status: 'EXITED' },
        });

        // Card is removed from the active panel
        await expect(webview.locator('.active-card')).toHaveCount(0, { timeout: 3_000 });
        // App is selectable again in the list
        await expect(webview.locator('input[type="checkbox"][data-app="mock-service-a"]')).toBeEnabled({ timeout: 3_000 });
        // "Active Sessions" section header is gone when panel is empty
        await expect(webview.locator('.section-label', { hasText: 'Active Sessions' })).toHaveCount(0);
      });
    });

    test('APP_DEBUG_STATUS ERROR shows error message and retry button', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();

        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-a', status: 'ERROR', message: 'SSH tunnel failed' },
        });

        const activeCard = webview.locator('.active-card', { hasText: 'mock-service-a' });
        await expect(activeCard.getByText('SSH tunnel failed')).toBeVisible({ timeout: 3_000 });
        // Retry button must appear for ERROR state
        await expect(activeCard.locator('[data-retry-app="mock-service-a"]')).toBeVisible({ timeout: 3_000 });
        await expect(activeCard.locator('[data-packages-app]')).toHaveCount(0);
        // Stop button still present
        await expect(activeCard.locator('[data-stop-app="mock-service-a"]')).toBeVisible();
      });
    });

    test('Stop single session click removes the active card', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();

        // Click the stop button — extension emits EXITED which propagates back to the webview
        await webview.locator('[data-stop-app="mock-service-a"]').click();

        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).not.toBeVisible({ timeout: 5_000 });
        await expect(webview.locator('.active-card')).toHaveCount(0, { timeout: 5_000 });
        await expect(webview.locator('input[type="checkbox"][data-app="mock-service-a"]')).toBeEnabled({ timeout: 5_000 });
        await expect(webview.locator('#btn-stop-all-sessions')).toHaveCount(0);
      });
    });

    test('APP_DEBUG_STATUS SSH_ENABLING and SSH_RESTARTING show correct status text', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();
        const activeCard = webview.locator('.active-card', { hasText: 'mock-service-a' });

        // SSH_ENABLING: spinner + "Enabling SSH…"
        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-a', status: 'SSH_ENABLING' },
        });
        await expect(activeCard.locator('.spinner')).toBeVisible({ timeout: 3_000 });
        await expect(activeCard.getByText(/Enabling SSH/)).toBeVisible({ timeout: 3_000 });
        // Stop button present, with no extra action button or retry button
        await expect(activeCard.locator('[data-stop-app="mock-service-a"]')).toBeVisible();
        await expect(activeCard.locator('.active-open-btn')).toHaveCount(0);
        await expect(activeCard.locator('[data-retry-app]')).toHaveCount(0);

        // SSH_RESTARTING: spinner + "Restarting app…"
        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-a', status: 'SSH_RESTARTING' },
        });
        await expect(activeCard.getByText(/Restarting app/)).toBeVisible({ timeout: 3_000 });
        await expect(activeCard.locator('.spinner')).toBeVisible({ timeout: 3_000 });
      });
    });

    test('ATTACHED state keeps Package button and port in card title without Open App button', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();
        const activeCard = webview.locator('.active-card', { hasText: 'mock-service-a' });
        // Port shown in card title even in TUNNELING state
        await expect(activeCard.locator('.active-card-port')).toContainText(':20000');
        // No secondary action is shown before the debugger reaches ATTACHED
        await expect(activeCard.locator('.active-open-btn')).toHaveCount(0);

        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-a', status: 'ATTACHED' },
        });

        await expect(activeCard.locator('.active-open-btn')).toHaveCount(0);
        await expect(activeCard.locator('.active-packages-btn')).toBeVisible({ timeout: 3_000 });
        await expect(activeCard.locator('.active-packages-btn')).toContainText('Package');
        // Stop button still present, no retry button (not ERROR)
        await expect(activeCard.locator('[data-stop-app="mock-service-a"]')).toBeVisible();
        await expect(activeCard.locator('[data-retry-app]')).toHaveCount(0);
      });
    });

    test('ATTACHED with unmappedApps shows "no src" badge on the session card', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Inject DEBUG_CONNECTING with mock-service-a in unmappedApps (no local folder)
        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: {
            appNames: ['mock-service-a'],
            ports: { 'mock-service-a': 20000 },
            unmappedApps: ['mock-service-a'],
          },
        });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();

        // In TUNNELING state the "no src" badge is not yet shown
        await expect(webview.locator('.active-card-no-src')).toHaveCount(0);

        // Attach the debugger — "no src" badge should now appear alongside "Debugger Attached"
        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-a', status: 'ATTACHED' },
        });

        const activeCard = webview.locator('.active-card', { hasText: 'mock-service-a' });
        await expect(activeCard.getByText('Debugger Attached')).toBeVisible({ timeout: 3_000 });
        // "no src" badge is shown because the app has no mapped local source folder
        await expect(activeCard.locator('.active-card-no-src')).toBeVisible({ timeout: 3_000 });
        await expect(activeCard.locator('.active-card-no-src')).toContainText('no src');
      });
    });

    test('Stop All button absent with one session, visible and shows count with two or more', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Single session: Stop All button must NOT appear
        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });
        await expect(webview.locator('.active-card')).toHaveCount(1, { timeout: 3_000 });
        await expect(webview.locator('#btn-stop-all-sessions')).toHaveCount(0);

        // Second session: Stop All button must appear with count
        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-c'], ports: { 'mock-service-c': 20001 } },
        });
        await expect(webview.locator('.active-card')).toHaveCount(2, { timeout: 3_000 });
        await expect(webview.locator('#btn-stop-all-sessions')).toBeVisible({ timeout: 3_000 });
        await expect(webview.locator('#btn-stop-all-sessions')).toContainText('2');

        // After one session exits (count drops to 1): Stop All must disappear
        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-a', status: 'EXITED' },
        });
        await expect(webview.locator('.active-card')).toHaveCount(1, { timeout: 3_000 });
        await expect(webview.locator('#btn-stop-all-sessions')).toHaveCount(0, { timeout: 3_000 });
        // Remaining card (mock-service-c) is still shown
        await expect(webview.locator('.active-card', { hasText: 'mock-service-c' })).toBeVisible();
      });
    });
  });

  test.describe('Packages Browser', () => {
    test('User can open Packages from an attached session card and browse an inline tree', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a'],
          ports: { 'mock-service-a': 20000 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await setPackageFixture(webview, 'mock-service-a', [
          createPackageFixture({
            name: 'sample-client',
            files: ['dist/client.js'],
          }),
          createPackageFixture({
            name: '@sample-org/demo-kit',
            version: '1.4.0',
            files: ['dist/main.js'],
          }),
        ]);
        await startPackagesErrorMonitor(webview);

        const activeCard = webview.locator('.active-card', { hasText: 'mock-service-a' });
        await expect(activeCard.locator('.active-packages-btn')).toBeVisible({ timeout: 3_000 });
        await expect(activeCard.locator('.active-open-btn')).toHaveCount(0);
        await expect(activeCard.locator('.active-packages-btn')).toContainText('Package');

        await activeCard.locator('.active-packages-btn').click();

        await expect(webview.locator('.step-header .step-title')).toHaveCount(0);
        await expect(
          webview.getByText('Browse loaded package sources for the current debug session and filter them before opening files.'),
        ).toHaveCount(0);
        await expect(webview.locator('.packages-session-heading')).toHaveText('Debug Session');
        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await expect(webview.locator('#packages-search-input')).toBeVisible();
        await expect(webview.locator('.packages-tree-badge')).toHaveCount(0);
        await expect(webview.locator('#btn-refresh-packages')).toContainText('Reload');
        await captureStepEvidence(workbenchPage, 'packages-tree-opened');

        const headingBox = await webview.locator('.packages-session-heading').boundingBox();
        const refreshBox = await webview.locator('#btn-refresh-packages').boundingBox();
        expect(headingBox).not.toBeNull();
        expect(refreshBox).not.toBeNull();
        expect(Math.abs((refreshBox?.y ?? 0) - (headingBox?.y ?? 0))).toBeLessThan(8);
        expect((refreshBox?.x ?? 0)).toBeGreaterThan((headingBox?.x ?? 0) + 40);

        await expect(webview.locator('.packages-tree-package-row')).toHaveCount(2, { timeout: 3_000 });
        await expect(webview.locator('#btn-refresh-packages')).toBeEnabled();
        await webview.locator('.packages-tree-package-row', { hasText: 'sample-client' }).click();
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'dist' })).toHaveCount(1, { timeout: 3_000 });
        await webview.locator('.packages-tree-folder-row', { hasText: 'dist' }).click();
        await expect(webview.locator('.packages-tree-file-row', { hasText: 'client.js' })).toBeVisible({ timeout: 3_000 });

        const sampleClientLabel = webview.locator('.packages-tree-package-row', { hasText: 'sample-client' }).locator('.packages-tree-label');
        const sampleClientWeight = await readCssProperty(sampleClientLabel, 'font-weight');
        expect(Number.parseInt(sampleClientWeight || '400', 10)).toBeLessThan(600);

        const packageIcon = webview
          .locator('.packages-tree-package-row', { hasText: 'sample-client' })
          .locator('.packages-tree-icon-package');
        const folderIcon = webview.locator('.packages-tree-folder-row', { hasText: 'dist' }).locator('.packages-tree-icon-folder');
        const fileIcon = webview.locator('.packages-tree-file-row', { hasText: 'client.js' }).locator('.packages-tree-icon-file');
        await expect(packageIcon).toBeVisible();
        await expect(folderIcon).toBeVisible();
        await expect(fileIcon).toBeVisible();

        const packageIconColor = await readCssProperty(packageIcon, 'color');
        const folderIconColor = await readCssProperty(folderIcon, 'color');
        const fileIconColor = await readCssProperty(fileIcon, 'color');
        expect(packageIconColor).not.toBe('');
        expect(folderIconColor).not.toBe('');
        expect(fileIconColor).not.toBe('');

        await webview.locator('#packages-search-input').fill('@sample-org');
        await expect(webview.locator('.packages-tree-package-row')).toHaveCount(1, { timeout: 3_000 });
        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' })).toBeVisible();
        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit@1.4.0' })).toHaveCount(0);
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'dist' })).toHaveCount(0, {
          timeout: 3_000,
        });
        await webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' }).click();
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'dist' })).toBeVisible({ timeout: 3_000 });

        await webview.locator('.packages-tree-folder-row', { hasText: 'dist' }).click();
        await expect(webview.locator('.packages-tree-file-row', { hasText: 'main.js' })).toBeVisible({ timeout: 3_000 });

        await webview.locator('#btn-back-packages').click();
        await expectReadyScreen(webview);
        const packageErrorEvents = await stopPackagesErrorMonitor(webview);
        expect(packageErrorEvents).toEqual([]);
        await clearPackageFixtures(webview);
      });
    });

    test('User can switch apps inside Packages and see each app package list independently', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a', 'mock-service-c'],
          ports: { 'mock-service-a': 20000, 'mock-service-c': 20001 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await emitAppDebugStatus(webview, { appName: 'mock-service-c', status: 'ATTACHED' });
        await setPackageFixture(webview, 'mock-service-a', [
          createPackageFixture({
            name: 'sample-alpha',
            files: ['index.js'],
          }),
        ]);
        await setPackageFixture(webview, 'mock-service-c', [
          createPackageFixture({
            name: '@sample-org/demo-worker',
            version: '2.0.0',
            files: ['dist/worker.js'],
          }),
        ]);
        await startPackagesErrorMonitor(webview);

        await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await captureStepEvidence(workbenchPage, 'packages-switch-apps-initial');

        await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-alpha' })).toBeVisible({ timeout: 3_000 });

        await webview.locator('#packages-app-select').selectOption('mock-service-c');
        await captureStepEvidence(workbenchPage, 'packages-switch-apps-secondary');

        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-worker' })).toBeVisible({ timeout: 3_000 });
        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-worker@2.0.0' })).toHaveCount(0);
        await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-alpha' })).toHaveCount(0);
        const packageErrorEvents = await stopPackagesErrorMonitor(webview);
        expect(packageErrorEvents).toEqual([]);
        await clearPackageFixtures(webview);
      });
    });

    test('Opening Packages immediately after attach waits for sources instead of flashing a false error', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a'],
          ports: { 'mock-service-a': 20000 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await setPackageFixture(
          webview,
          'mock-service-a',
          [
            createPackageFixture({
              name: 'sample-client',
              files: ['dist/client.js'],
            }),
          ],
          {
            loadedSourcesPlan: [
              { kind: 'empty', delayMs: 150 },
              { kind: 'packages', delayMs: 150 },
            ],
          },
        );
        await startPackagesErrorMonitor(webview);

        await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await captureStepEvidence(workbenchPage, 'packages-immediate-open-before-sources');

        await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-client' })).toBeVisible({
          timeout: 4_000,
        });
        await expect(webview.locator('#btn-refresh-packages')).toBeEnabled();
        await expect(webview.locator('.packages-error')).toHaveCount(0);

        const packageErrorEvents = await stopPackagesErrorMonitor(webview);
        expect(packageErrorEvents).toEqual([]);
        await clearPackageFixtures(webview);
      });
    });

    test('Opening Packages immediately after a started session waits for the child debug session to appear', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-target-after-apps' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await startPackagesErrorMonitor(webview);

        await webview.locator('input[type="checkbox"][data-app="mock-service-a"]').check();
        await webview.locator('#btn-start-debug').click();
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible({ timeout: 3_000 });

        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await setPackageFixture(
          webview,
          'mock-service-a',
          [
            createPackageFixture({
              name: 'sample-client',
              files: ['dist/client.js'],
            }),
          ],
          {
            sessionAvailability: { childSessionDelayMs: 2_500 },
          },
        );

        const packagesButton = webview
          .locator('.active-card', { hasText: 'mock-service-a' })
          .locator('.active-packages-btn');
        await expect(packagesButton).toBeVisible({ timeout: 3_000 });
        await packagesButton.click();
        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await captureStepEvidence(workbenchPage, 'packages-immediate-open-before-child-session');
        await waitForObservation();

        await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-client' })).toBeVisible({
          timeout: 8_000,
        });
        await expect(webview.locator('.packages-error')).toHaveCount(0);
        await captureStepEvidence(workbenchPage, 'packages-immediate-open-after-child-session');
        await waitForObservation();

        const packageErrorEvents = await stopPackagesErrorMonitor(webview);
        expect(packageErrorEvents).toEqual([]);
        await clearPackageFixtures(webview);
      });
    });

    test('Reload becomes clickable again after a hanging package-source request times out', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a'],
          ports: { 'mock-service-a': 20000 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await setPackageFixture(
          webview,
          'mock-service-a',
          [
            createPackageFixture({
              name: 'sample-client',
              files: ['dist/client.js'],
            }),
          ],
          {
            loadedSourcesPlan: [
              { kind: 'hang' },
              { kind: 'packages', delayMs: 150 },
            ],
          },
        );
        await startPackagesErrorMonitor(webview);

        await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await expect(webview.locator('#btn-refresh-packages')).toBeDisabled();
        await captureStepEvidence(workbenchPage, 'packages-hanging-load');

        await expect(webview.locator('#btn-refresh-packages')).toBeEnabled({ timeout: 6_000 });
        await expect(webview.locator('.packages-error')).toBeVisible();

        const timeoutErrors = await readPackagesErrorEvents(webview);
        expect(timeoutErrors.some((message) => /timed out|timeout/i.test(message))).toBe(true);

        await webview.locator('#btn-refresh-packages').click();
        await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-client' })).toBeVisible({
          timeout: 4_000,
        });
        await expect(webview.locator('.packages-error')).toHaveCount(0);

        await stopPackagesErrorMonitor(webview);
        await clearPackageFixtures(webview);
      });
    });

    test('User can save a debug session package regex filter and apply it before search input filtering', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a'],
          ports: { 'mock-service-a': 20000 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await setPackageFixture(webview, 'mock-service-a', [
          createPackageFixture({
            name: 'sample-client',
            files: ['dist/client.js'],
          }),
          createPackageFixture({
            name: '@sample-org/demo-kit',
            version: '1.4.0',
            files: ['dist/main.js'],
          }),
        ]);
        await startPackagesErrorMonitor(webview);

        await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
        await expect(webview.locator('.packages-tree-package-row')).toHaveCount(2, { timeout: 3_000 });

        await webview.locator('#btn-packages-settings').click();
        await expect(webview.getByText('Debug Session Settings')).toBeVisible();
        await expect(webview.locator('#packages-filter-regex-input')).toBeVisible();
        await webview.locator('#packages-filter-regex-input').fill('^@sample-org/');
        await captureStepEvidence(workbenchPage, 'packages-settings-regex');
        await webview.locator('#btn-save-package-settings').click();

        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await expect(webview.locator('.packages-tree-package-row')).toHaveCount(1, { timeout: 3_000 });
        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' })).toBeVisible();
        await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-client' })).toHaveCount(0);

        await webview.locator('#packages-search-input').fill('sample-client');
        await expect(webview.locator('.packages-tree-package-row')).toHaveCount(0);
        await expect(webview.locator('.packages-empty')).toContainText('No packages or files match');

        await webview.locator('#btn-packages-settings').click();
        await expect(webview.locator('#packages-filter-regex-input')).toHaveValue('^@sample-org/');

        const packageErrorEvents = await stopPackagesErrorMonitor(webview);
        expect(packageErrorEvents).toEqual([]);
        await clearPackageFixtures(webview);
      });
    });

    test('Invalid debug session package regex is rejected in settings', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a'],
          ports: { 'mock-service-a': 20000 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await setPackageFixture(webview, 'mock-service-a', [
          createPackageFixture({
            name: 'sample-client',
            files: ['dist/client.js'],
          }),
        ]);

        await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
        await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-client' })).toBeVisible({
          timeout: 3_000,
        });

        await webview.locator('#btn-packages-settings').click();
        await expect(webview.locator('#packages-filter-regex-input')).toBeVisible();
        await webview.locator('#packages-filter-regex-input').fill('[');
        await webview.locator('#btn-save-package-settings').click();

        await expect(webview.getByText('Debug Session Settings')).toBeVisible();
        await expect(webview.locator('.error-box')).toContainText('Invalid regex');
        await expect(webview.locator('#packages-app-select')).toHaveCount(0);
        await clearPackageFixtures(webview);
      });
    });

    test('Tree expansion keeps the clicked package and folder in place while scrolling', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await waitForObservation();

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a'],
          ports: { 'mock-service-a': 20000 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await waitForObservation();
        const packages = Array.from({ length: 14 }, (_, index) =>
          createPackageFixture({
            name: index === 8 ? 'sample-scroll-target' : `sample-bucket-${String(index + 1).padStart(2, '0')}`,
            files: index === 8
              ? [
                  'demo-01/index.js',
                  'demo-02/index.js',
                  'demo-03/index.js',
                  'demo-04/index.js',
                  'demo-05/index.js',
                  'demo-06/index.js',
                  'demo-07/index.js',
                  'demo-08/index.js',
                  'demo-09/index.js',
                ]
              : ['dist/index.js'],
          }),
        );
        await setPackageFixture(webview, 'mock-service-a', packages);
        await startPackagesErrorMonitor(webview);

        await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await expect(webview.locator('.packages-error')).toHaveCount(0);
        await waitForObservation();
        await expect(webview.locator('.packages-error')).toHaveCount(0);
        await captureStepEvidence(workbenchPage, 'packages-scroll-before-expand');

        await positionPackageTreeRow(webview, '.packages-tree-package-row', 'sample-scroll-target', 12);
        const beforePackage = await readPackageTreeRowMetrics(webview, '.packages-tree-package-row', 'sample-scroll-target');
        await waitForObservation();

        await webview.locator('.packages-tree-package-row', { hasText: 'sample-scroll-target' }).click();
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'demo-08' })).toBeVisible({ timeout: 3_000 });
        await waitForObservation();

        const afterPackage = await readPackageTreeRowMetrics(webview, '.packages-tree-package-row', 'sample-scroll-target');
        expect(Math.abs(afterPackage.scrollTop - beforePackage.scrollTop)).toBeLessThan(24);
        expect(Math.abs(afterPackage.rowTop - beforePackage.rowTop)).toBeLessThan(24);

        await positionPackageTreeRow(webview, '.packages-tree-folder-row', 'demo-08', 140);
        const beforeFolder = await readPackageTreeRowMetrics(webview, '.packages-tree-folder-row', 'demo-08');
        await waitForObservation();

        await webview.locator('.packages-tree-folder-row', { hasText: 'demo-08' }).click();
        await expect(webview.locator('.packages-tree-file-row', { hasText: 'index.js' })).toBeVisible({ timeout: 3_000 });
        await waitForObservation();

        const afterFolder = await readPackageTreeRowMetrics(webview, '.packages-tree-folder-row', 'demo-08');
        expect(Math.abs(afterFolder.scrollTop - beforeFolder.scrollTop)).toBeLessThan(24);
        expect(Math.abs(afterFolder.rowTop - beforeFolder.rowTop)).toBeLessThan(24);

        const packageErrorEvents = await stopPackagesErrorMonitor(webview);
        expect(packageErrorEvents).toEqual([]);
        await clearPackageFixtures(webview);
      });
    });

    test('Search by package name keeps the package collapsible instead of forcing it open', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await waitForObservation();

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a'],
          ports: { 'mock-service-a': 20000 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await waitForObservation();
        await setPackageFixture(webview, 'mock-service-a', [
          createPackageFixture({
            name: '@sample-org/demo-kit',
            version: '1.4.0',
            files: [
              'dist/main.js',
              'dist/tasks/worker.js',
            ],
          }),
          createPackageFixture({
            name: 'sample-client',
            files: ['dist/client.js'],
          }),
        ]);
        await startPackagesErrorMonitor(webview);

        await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await expect(webview.locator('.packages-error')).toHaveCount(0);
        await waitForObservation();
        await expect(webview.locator('.packages-error')).toHaveCount(0);

        await webview.locator('#packages-search-input').fill('demo-kit');
        await expect(webview.locator('.packages-tree-package-row')).toHaveCount(1, { timeout: 3_000 });
        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' })).toBeVisible();
        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit@1.4.0' })).toHaveCount(0);
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'dist' })).toHaveCount(0);
        await waitForObservation();
        await captureStepEvidence(workbenchPage, 'packages-search-package-filtered');

        await webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' }).click();
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'dist' })).toBeVisible({ timeout: 3_000 });
        await waitForObservation();
        await webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' }).click();
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'dist' })).toHaveCount(0);
        await waitForObservation();

        const packageErrorEvents = await stopPackagesErrorMonitor(webview);
        expect(packageErrorEvents).toEqual([]);
        await clearPackageFixtures(webview);
      });
    });

    test('Search with descendant matches still lets users collapse matching folders', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await waitForObservation();

        await emitDebugConnecting(webview, {
          appNames: ['mock-service-a'],
          ports: { 'mock-service-a': 20000 },
        });
        await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
        await waitForObservation();
        await setPackageFixture(webview, 'mock-service-a', [
          createPackageFixture({
            name: '@sample-org/demo-kit',
            version: '1.4.0',
            files: [
              'dist/main.js',
              'dist/tasks/worker.js',
            ],
          }),
        ]);
        await startPackagesErrorMonitor(webview);

        await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
        await expect(webview.locator('#packages-app-select')).toBeVisible();
        await expect(webview.locator('.packages-error')).toHaveCount(0);
        await waitForObservation();
        await expect(webview.locator('.packages-error')).toHaveCount(0);

        await webview.locator('#packages-search-input').fill('worker');
        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' })).toBeVisible({ timeout: 3_000 });
        await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit@1.4.0' })).toHaveCount(0);
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'dist' })).toBeVisible({ timeout: 3_000 });
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'tasks' })).toBeVisible({ timeout: 3_000 });
        await expect(webview.locator('.packages-tree-file-row', { hasText: 'worker.js' })).toBeVisible({ timeout: 3_000 });
        await waitForObservation();
        await captureStepEvidence(workbenchPage, 'packages-search-descendant-match');

        await webview.locator('.packages-tree-folder-row', { hasText: 'dist' }).click();
        await expect(webview.locator('.packages-tree-folder-row', { hasText: 'tasks' })).toHaveCount(0);
        await expect(webview.locator('.packages-tree-file-row', { hasText: 'worker.js' })).toHaveCount(0);
        await waitForObservation();

        const packageErrorEvents = await stopPackagesErrorMonitor(webview);
        expect(packageErrorEvents).toEqual([]);
        await clearPackageFixtures(webview);
      });
    });

    test('User can search package file contents and open the matching file at the matched line', async () => {
      const workspaceDir = await createTempDirectory('cds-debug-e2e-package-content-');

      try {
        const contentFixture = await createPackageFixtureInWorkspace(workspaceDir, {
          name: 'sample-client',
          files: [
            {
              relativePath: 'dist/client.js',
              content: [
                'export function createClient() {',
                '  const ready = true;',
                '  return ready;',
                '}',
                '',
                'sampleTokenMarker();',
              ].join('\n'),
            },
          ],
        });

        await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
          const webview = await openCdsDebugWebview(workbenchPage);
          await completeMappingToReadyWithFolder(webview, workspaceDir);
          await waitForObservation();

          await emitDebugConnecting(webview, {
            appNames: ['mock-service-a'],
            ports: { 'mock-service-a': 20000 },
          });
          await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
          await setPackageFixture(webview, 'mock-service-a', [contentFixture], { localRoot: workspaceDir });
          await startPackagesErrorMonitor(webview);

          await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
          await expect(webview.locator('#packages-app-select')).toBeVisible();
          await webview.locator('#packages-search-input').fill('sampleTokenMarker');
          await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-client' })).toBeVisible({
            timeout: 5_000,
          });
          await expect(webview.locator('.packages-tree-file-row', { hasText: 'client.js' })).toBeVisible({
            timeout: 5_000,
          });
          await captureStepEvidence(workbenchPage, 'packages-search-content-match');
          await waitForObservation();

          await webview.locator('.packages-tree-file-row', { hasText: 'client.js' }).click();
          await expectEditorCursorPosition(workbenchPage, 6, 1);
          await captureStepEvidence(workbenchPage, 'packages-search-content-opened');

          const packageErrorEvents = await stopPackagesErrorMonitor(webview);
          expect(packageErrorEvents).toEqual([]);
          await clearPackageFixtures(webview);
        }, workspaceDir);
      } finally {
        await removeDirWithRetry(workspaceDir);
      }
    });

    test('User can search package file contents when the debugger reports a remote package path', async () => {
      const workspaceDir = await createTempDirectory('cds-debug-e2e-package-remote-content-');

      try {
        const contentFixture = await createPackageFixtureInWorkspace(workspaceDir, {
          name: '@sample-org/demo-kit',
          version: '1.4.0',
          files: [
            {
              relativePath: 'dist/main.js',
              content: [
                'export function createSampleKit() {',
                '  return "demo";',
                '}',
              ].join('\n'),
            },
          ],
        }, {
          reportedRootDir: '/sample-app',
        });

        await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
          const webview = await openCdsDebugWebview(workbenchPage);
          await completeMappingToReadyWithFolder(webview, workspaceDir);
          await waitForObservation();

          await emitDebugConnecting(webview, {
            appNames: ['mock-service-a'],
            ports: { 'mock-service-a': 20000 },
          });
          await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
          await setPackageFixture(webview, 'mock-service-a', [contentFixture], { localRoot: workspaceDir });
          await startPackagesErrorMonitor(webview);

          await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
          await expect(webview.locator('#packages-app-select')).toBeVisible();
          await webview.locator('#packages-search-input').fill('createSampleKit');
          await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' })).toBeVisible({
            timeout: 5_000,
          });
          await expect(webview.locator('.packages-tree-file-row', { hasText: 'main.js' })).toBeVisible({
            timeout: 5_000,
          });
          await captureStepEvidence(workbenchPage, 'packages-search-remote-content-match');
          await waitForObservation();

          await webview.locator('.packages-tree-file-row', { hasText: 'main.js' }).click();
          await expectEditorCursorPosition(workbenchPage, 1, 17);
          await captureStepEvidence(workbenchPage, 'packages-search-remote-content-opened');

          const packageErrorEvents = await stopPackagesErrorMonitor(webview);
          expect(packageErrorEvents).toEqual([]);
          await clearPackageFixtures(webview);
        }, workspaceDir);
      } finally {
        await removeDirWithRetry(workspaceDir);
      }
    });

    test('Debug session package regex filtering still applies before content search results are shown', async () => {
      const workspaceDir = await createTempDirectory('cds-debug-e2e-package-filter-');

      try {
        const scopedFixture = await createPackageFixtureInWorkspace(workspaceDir, {
          name: '@sample-org/demo-kit',
          version: '1.4.0',
          files: [
            {
              relativePath: 'dist/main.js',
              content: 'export const sampleScopedToken = true;\n',
            },
          ],
        });
        const genericFixture = await createPackageFixtureInWorkspace(workspaceDir, {
          name: 'sample-client',
          files: [
            {
              relativePath: 'dist/client.js',
              content: 'export const sampleScopedToken = false;\n',
            },
          ],
        });

        await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
          const webview = await openCdsDebugWebview(workbenchPage);
          await completeMappingToReadyWithFolder(webview, workspaceDir);
          await waitForObservation();

          await emitDebugConnecting(webview, {
            appNames: ['mock-service-a'],
            ports: { 'mock-service-a': 20000 },
          });
          await emitAppDebugStatus(webview, { appName: 'mock-service-a', status: 'ATTACHED' });
          await setPackageFixture(webview, 'mock-service-a', [scopedFixture, genericFixture]);
          await startPackagesErrorMonitor(webview);

          await webview.locator('.active-card', { hasText: 'mock-service-a' }).locator('.active-packages-btn').click();
          await expect(webview.locator('.packages-tree-package-row')).toHaveCount(2, { timeout: 5_000 });

          await webview.locator('#btn-packages-settings').click();
          await webview.locator('#packages-filter-regex-input').fill('^@sample-org/');
          await webview.locator('#btn-save-package-settings').click();
          await expect(webview.locator('#packages-app-select')).toBeVisible();

          await webview.locator('#packages-search-input').fill('sampleScopedToken');
          await expect(webview.locator('.packages-tree-package-row', { hasText: '@sample-org/demo-kit' })).toBeVisible({
            timeout: 5_000,
          });
          await expect(webview.locator('.packages-tree-package-row', { hasText: 'sample-client' })).toHaveCount(0);
          await expect(webview.locator('.packages-tree-file-row', { hasText: 'main.js' })).toBeVisible({
            timeout: 5_000,
          });
          await captureStepEvidence(workbenchPage, 'packages-search-content-regex-filtered');

          const packageErrorEvents = await stopPackagesErrorMonitor(webview);
          expect(packageErrorEvents).toEqual([]);
          await clearPackageFixtures(webview);
        }, workspaceDir);
      } finally {
        await removeDirWithRetry(workspaceDir);
      }
    });
  });

  // ─── Ready Screen — Actions and Navigation ─────────────────────────────────

  test.describe('Ready Screen — Actions and Navigation', () => {
    test('DEBUG_ERROR clears pending sessions and shows an error message', async () => {
      // Uses slow-target-after-apps so the first app load completes normally, but the
      // Start Debug cfTarget() blocks long enough for us to inject DEBUG_ERROR before
      // the extension resolves the start request on its own.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-target-after-apps' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Trigger optimistic PENDING sessions
        await webview.locator('#chk-select-all').check();
        await webview.locator('#btn-start-debug').click();
        await expect(webview.locator('.active-card')).toHaveCount(2, { timeout: 3_000 });

        // Simulate a cfTarget failure arriving before DEBUG_CONNECTING
        await injectMessage(webview, {
          type: 'DEBUG_ERROR',
          payload: { message: 'CF target failed: network timeout' },
        });

        // All PENDING cards must be cleared
        await expect(webview.locator('.active-card')).toHaveCount(0, { timeout: 3_000 });
        // Error message must be visible in the ready screen
        await expect(webview.locator('.error-box')).toContainText('CF target failed: network timeout', { timeout: 3_000 });
        // Retry button (#btn-retry-apps) must appear alongside the error box on the ready screen
        await expect(webview.locator('#btn-retry-apps')).toBeVisible({ timeout: 3_000 });
      });
    });

    test('Change Mapping with no active sessions returns to Select CF Org', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await webview.locator('#btn-remap').click();

        await expect(webview.getByText('Select CF Org')).toBeVisible({ timeout: 5_000 });
        // Org list is rendered (previously logged-in orgs are preserved in state)
        await expect(webview.locator('input[name="cf-org"]')).toHaveCount(2);
      });
    });

    test('Cancel app loading returns to Ready screen when apps were previously loaded', async () => {
      // Uses slow-target so cfTarget blocks for a few seconds on every LOAD_APPS call.
      // This gives a stable LOADING_APPS window after the refresh click,
      // long enough to assert all screen elements and click cancel before either
      // the first or second cfTarget process can complete and send APPS_LOADED.
      // force:true on the refresh click bypasses Playwright actionability checks
      // that can hang indefinitely when the webview DOM is briefly re-rendering.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-target' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await goToFolderSelection(webview);
        await injectSelectedFolder(webview, MOCK_GROUP_FOLDER);

        // Kick off the save (goes to LOADING_APPS; first cfTarget sleeps briefly)
        await webview.locator('#btn-save-mapping').click();
        await expect(webview.locator('#btn-cancel-load-apps')).toBeVisible();

        // Seed state.apps by injecting APPS_LOADED — bypasses the slow cfTarget
        await injectMessage(webview, {
          type: 'APPS_LOADED',
          payload: {
            apps: [
              { name: 'mock-service-a', state: 'started', urls: ['mock-service-a.cfapps.example.com'] },
              { name: 'mock-service-b', state: 'stopped', urls: [] },
              { name: 'mock-service-c', state: 'started', urls: ['mock-service-c.cfapps.example.com'] },
            ],
          },
        });
        await expectReadyScreen(webview);

        // Refresh — second cfTarget also sleeps briefly, keeping LOADING_APPS stable.
        // force:true avoids an indefinite actionability-check hang caused by rapid
        // DOM replacement when the extension's success response races with the click.
        await webview.locator('#btn-refresh-apps').click({ force: true });
        await expect(webview.getByText(/Loading apps for/i)).toBeVisible({ timeout: 5_000 });
        await expect(webview.locator('.spinner')).toBeVisible({ timeout: 5_000 });
        await expect(webview.locator('#btn-cancel-load-apps')).toBeVisible({ timeout: 5_000 });

        // Cancel must navigate to READY (state.apps.length > 0), not SELECT_FOLDER
        await webview.locator('#btn-cancel-load-apps').click();
        await expectReadyScreen(webview);
        await expect(webview.getByText('mock-service-a')).toBeVisible();
        // No LOADING_APPS elements remain on READY
        await expect(webview.locator('#btn-cancel-load-apps')).toHaveCount(0);
        await expect(webview.locator('.spinner')).toHaveCount(0);
      });
    });

    test('Refresh Apps reloads and re-displays the app list', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'reload-changes' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await expect(webview.getByText('mock-service-c')).toBeVisible();
        await expect(webview.locator('.app-row', { hasText: 'mock-service-d' })).toHaveCount(0);

        await webview.locator('#btn-refresh-apps').click();

        await expectReadyScreen(webview);
        await expect(webview.getByText('mock-service-a')).toBeVisible();
        await expect(webview.getByText('mock-service-b')).toBeVisible();
        await expect(webview.getByText('mock-service-d')).toBeVisible();
        await expect(webview.locator('.app-row', { hasText: 'mock-service-c' })).toHaveCount(0);
      });
    });
  });

  // ─── Settings Screen ───────────────────────────────────────────────────────

  test.describe('Breakpoint Snapshot Panel', () => {
    test('User can open breakpoint snapshots screen from launcher and return back', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await enableBreakpointSnapshotHandlingFromSettings(webview);
        await openBreakpointSnapshotsScreen(webview);
        await expect(webview.locator('.bp-section-label')).toContainText('Breakpoint Snapshots');

        await webview.locator('#btn-back-breakpoint-snapshots').click();
        await expect(webview.locator('.step-title')).toContainText('Debug Launcher');
      });
    });

    test('Injected snapshots render as list and clicking item updates detail view', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await enableBreakpointSnapshotHandlingFromSettings(webview);
        await openBreakpointSnapshotsScreen(webview);

        await injectMessage(webview, {
          type: 'BREAKPOINT_SNAPSHOTS',
          payload: {
            snapshots: [
              {
                id: 'snap-2',
                appName: 'orders-service',
                sessionName: 'Debug: orders-service',
                reason: 'breakpoint',
                createdAt: 1713260100000,
                threadId: 1,
                autoResumed: true,
                location: { sourcePath: '/workspace/srv/orders-service.js', line: 88, column: 16, functionName: 'onRead' },
                scopes: [
                  {
                    name: 'Local',
                    expensive: false,
                    variables: [
                      { name: 'req.id', value: 'abc-2', type: 'string' },
                      { name: 'token', value: '[REDACTED]', type: 'string' },
                    ],
                  },
                ],
              },
              {
                id: 'snap-1',
                appName: 'catalog-service',
                sessionName: 'Debug: catalog-service',
                reason: 'breakpoint',
                createdAt: 1713260000000,
                threadId: 1,
                autoResumed: true,
                location: { sourcePath: '/workspace/srv/catalog-service.js', line: 42, column: 9, functionName: 'beforeCreate' },
                scopes: [
                  {
                    name: 'Local',
                    expensive: false,
                    variables: [
                      {
                        name: 'req',
                        value: '{id: \"U100\", headers: {…}}',
                        type: 'object',
                        children: [
                          { name: 'id', value: 'U100', type: 'string' },
                          {
                            name: 'headers',
                            value: '{authorization: [REDACTED]}',
                            type: 'object',
                            children: [
                              { name: 'authorization', value: '[REDACTED]', type: 'string' },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });

        await expect(webview.locator('#breakpoint-snapshots-panel')).toBeVisible();
        await expect(webview.locator('.bp-section-label')).toContainText('Breakpoint Snapshots');
        await expect(webview.locator('.bp-count')).toContainText('2');
        await expect(webview.locator('.bp-item')).toHaveCount(2);

        // Default selection is first item (snap-2 / orders-service)
        await expect(webview.locator('.bp-detail')).toContainText('orders-service');
        await expect(webview.locator('.bp-detail')).toContainText('onRead');
        await expect(webview.locator('.bp-detail')).toContainText('[REDACTED]');

        // Selecting another snapshot updates detail
        await webview.locator('[data-breakpoint-snapshot-id=\"snap-1\"]').click();
        await expect(webview.locator('.bp-detail')).toContainText('catalog-service');
        await expect(webview.locator('.bp-detail')).toContainText('beforeCreate');
        await expect(webview.locator('.bp-detail')).toContainText('headers');
        await expect(webview.locator('.bp-detail')).toContainText('authorization');
      });
    });

    test('Snapshot panel clear button resets list to empty state', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await enableBreakpointSnapshotHandlingFromSettings(webview);
        await openBreakpointSnapshotsScreen(webview);

        await injectMessage(webview, {
          type: 'BREAKPOINT_SNAPSHOTS',
          payload: {
            snapshots: [
              {
                id: 'snap-1',
                appName: 'catalog-service',
                sessionName: 'Debug: catalog-service',
                reason: 'breakpoint',
                createdAt: 1713260000000,
                threadId: 1,
                autoResumed: true,
                location: { sourcePath: '/workspace/srv/catalog-service.js', line: 42, column: 9, functionName: 'beforeCreate' },
                scopes: [],
              },
            ],
          },
        });
        await expect(webview.locator('.bp-item')).toHaveCount(1);
        await expect(webview.locator('#btn-clear-breakpoint-snapshots')).toBeEnabled();

        await webview.locator('#btn-clear-breakpoint-snapshots').click();

        await expect(webview.locator('.bp-item')).toHaveCount(0);
        await expect(webview.locator('.bp-empty')).toContainText('No breakpoint snapshots yet');
        await expect(webview.locator('#btn-clear-breakpoint-snapshots')).toBeDisabled();
      });
    });

    test('BREAKPOINT_SNAPSHOT_ADDED increments list and preserves selection on subsequent snapshots', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await enableBreakpointSnapshotHandlingFromSettings(webview);
        await openBreakpointSnapshotsScreen(webview);

        // Panel starts empty
        await expect(webview.locator('.bp-empty')).toBeVisible();
        await expect(webview.locator('#btn-clear-breakpoint-snapshots')).toBeDisabled();

        // First live snapshot arrives
        await injectMessage(webview, {
          type: 'BREAKPOINT_SNAPSHOT_ADDED',
          payload: {
            snapshot: {
              id: 'live-snap-1',
              appName: 'catalog-service',
              sessionName: 'Debug: catalog-service',
              reason: 'breakpoint',
              createdAt: 1713260000000,
              threadId: 1,
              autoResumed: true,
              location: { sourcePath: '/workspace/srv/catalog-service.js', line: 42, column: 9, functionName: 'beforeCreate' },
              scopes: [
                {
                  name: 'Local',
                  expensive: false,
                  variables: [{ name: 'req.user', value: '{ id: "U100" }', type: 'object' }],
                },
              ],
            },
          },
        });

        await expect(webview.locator('.bp-item')).toHaveCount(1);
        await expect(webview.locator('.bp-count')).toContainText('1');
        await expect(webview.locator('.bp-detail')).toContainText('catalog-service');
        await expect(webview.locator('.bp-detail')).toContainText('beforeCreate');

        // Second live snapshot from a different service
        await injectMessage(webview, {
          type: 'BREAKPOINT_SNAPSHOT_ADDED',
          payload: {
            snapshot: {
              id: 'live-snap-2',
              appName: 'orders-service',
              sessionName: 'Debug: orders-service',
              reason: 'breakpoint',
              createdAt: 1713260050000,
              threadId: 2,
              autoResumed: true,
              location: { sourcePath: '/workspace/srv/orders-service.js', line: 88, column: 16, functionName: 'onRead' },
              scopes: [],
            },
          },
        });

        // List grows to 2; selection (catalog-service) is preserved since it still exists
        await expect(webview.locator('.bp-item')).toHaveCount(2);
        await expect(webview.locator('.bp-count')).toContainText('2');
        await expect(webview.locator('.bp-detail')).toContainText('catalog-service');
        // The clear button becomes enabled once snapshots exist
        await expect(webview.locator('#btn-clear-breakpoint-snapshots')).toBeEnabled();
      });
    });
  });

  test.describe('Settings Screen', () => {
    test('Settings shows keychain credential buttons (update + clear) when source is keychain', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await setCredentialStatusOverride(webview, {
          hasCredentials: true,
          email: 'keychain.user@example.com',
          source: 'keychain',
        });
        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        await expect.poll(async () => {
          await refreshCredentialStatus(webview);
          return webview.locator('.cred-source-badge.keychain').isVisible();
        }).toBe(true);

        // Keychain section: source badge, email, and update/clear buttons
        await expect(webview.locator('.cred-source-badge.keychain')).toBeVisible();
        await expect(webview.locator('.cred-info-email')).toContainText('keychain.user@example.com');
        await expect(webview.locator('#btn-update-credentials')).toBeVisible();
        await expect(webview.locator('#btn-clear-credentials')).toBeVisible();
        await clearCredentialStatusOverride(webview);
      });
    });

    test('Settings shows no-credential state when source is none', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await setCredentialStatusOverride(webview, {
          hasCredentials: true,
          email: '',
          source: 'none',
        });
        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        await expect.poll(async () => {
          await refreshCredentialStatus(webview);
          return webview.getByText('No credentials configured.').isVisible();
        }).toBe(true);

        await expect(webview.getByText('No credentials configured.')).toBeVisible();
        await expect(webview.locator('#btn-update-credentials')).toBeVisible();
        await expect(webview.locator('#btn-clear-credentials')).toHaveCount(0);
        await clearCredentialStatusOverride(webview);
      });
    });

    test('Settings shows "Stopping sync" when cache disabled while sync is still running', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        await expect(webview.locator('#chk-cache-enabled')).toBeChecked();

        // Drive running sync first, then disable cache to force the "Stopping sync…" transition.
        await injectMessage(webview, {
          type: 'SYNC_STATUS',
          payload: { isRunning: true, lastCompletedAt: null, currentRegion: null, currentOrg: null, done: 0, total: 14 },
        });
        await injectMessage(webview, {
          type: 'CACHE_CONFIG',
          payload: { enabled: false, intervalHours: 24 },
        });

        await expect.poll(async () => {
          const runningRow = webview.locator('.sync-status-row.running');
          if (await runningRow.count() === 0) return '';
          return (await runningRow.first().innerText()).trim();
        }).toContain('Stopping sync');

        await expect(webview.locator('.sync-status-row.running .spinner')).toBeVisible();
      });
    });

    test('Settings sync running state shows progress bar and spinner', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();

        // Inject SYNC_STATUS with isRunning=true and a currentOrg. Background cache
        // sync can also emit real progress updates in the same session, so this test
        // only asserts stable "running" UI signals plus generic progress text.
        await injectMessage(webview, {
          type: 'SYNC_STATUS',
          payload: {
            isRunning: true,
            lastCompletedAt: null,
            currentRegion: 'eu10',
            currentOrg: 'mock-org-alpha',
            done: 3,
            total: 14,
          },
        });

        // Sync running: spinner + progress bar, Sync Now button disabled
        const runningRow = webview.locator('.sync-status-row.running');
        await expect(runningRow.locator('.spinner')).toBeVisible();
        await expect(webview.locator('.progress-bar-wrap')).toHaveCount(1);
        await expect(webview.locator('.progress-bar-fill')).toHaveAttribute('style', /width:\s*21%/);
        await expect(webview.locator('#btn-trigger-sync')).toBeDisabled();
        await expect.poll(async () => {
          return ((await runningRow.textContent()) ?? '').trim();
        }).toMatch(/(mock-org-alpha|Scanning|Logging into)/);
        await expect.poll(async () => {
          return ((await runningRow.textContent()) ?? '').trim();
        }).toMatch(/\(\d+\/\d+.*%\)/);
      });
    });

    test('Settings cache disabled state shows "Caching disabled" status and disables controls', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        // Wait for the extension's settings responses to be fully processed before injecting.
        // The extension sends GET_CACHE_CONFIG and GET_CREDENTIALS_STATUS responses in order;
        // .cred-info-email only appears after CREDENTIALS_STATUS (the last response) is received,
        // ensuring GET_CACHE_CONFIG's response has also landed — preventing a race where the
        // extension's CACHE_CONFIG { enabled: true } response overwrites the injected value.
        await expect(webview.locator('.cred-info-email')).toContainText(MOCK_ENV_EMAIL);

        // Inject CACHE_CONFIG with enabled=false
        await injectMessage(webview, {
          type: 'CACHE_CONFIG',
          payload: { enabled: false, intervalHours: 24 },
        });

        // Cache disabled: checkbox unchecked, interval select disabled, Sync Now disabled
        await expect(webview.locator('#chk-cache-enabled')).not.toBeChecked();
        await expect(webview.locator('#select-interval')).toBeDisabled();
        await expect(webview.locator('#btn-trigger-sync')).toBeDisabled();
        // Status row shows "Caching disabled" text
        await expect(webview.locator('.sync-status-row')).toContainText('Caching disabled');
      });
    });

    test('Back to Launcher button returns to the ready screen', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await webview.locator('#btn-gear').click();
        // Verify all Settings screen sections and elements
        await expect(webview.getByText('Settings')).toBeVisible();
        // SAP Credentials section — credentialMode: 'env' so env badge + email shown
        await expect(webview.locator('.section-label', { hasText: 'SAP Credentials' })).toBeVisible();
        await expect(webview.locator('.cred-source-badge.env')).toBeVisible();
        await expect(webview.locator('.cred-info-email')).toContainText(MOCK_ENV_EMAIL);
        await expect(webview.locator('.cred-info-icon[aria-label="Environment variable info"]')).toBeVisible();
        await expect(webview.locator('#btn-update-credentials')).toHaveCount(0);
        // Debug Behavior section with all preference toggles
        await expect(webview.locator('.section-label', { hasText: 'Debug Behavior' })).toBeVisible();
        await expect(webview.getByText(/Auto-open browser on attach/)).toBeVisible();
        await expect(webview.locator('#chk-open-browser')).toBeVisible();
        await expect(webview.getByText(/Breakpoint snapshot handling/)).toBeVisible();
        await expect(webview.locator('#chk-breakpoint-snapshot-handling')).toBeVisible();
        await expect(webview.locator('#chk-breakpoint-snapshot-handling')).not.toBeChecked();
        await expect(webview.getByText(/Branch auto-checkout/)).toBeVisible();
        await expect(webview.locator('#chk-branch-prep')).toBeVisible();
        // App Cache section with sync controls
        await expect(webview.locator('.section-label', { hasText: 'App Cache' })).toBeVisible();
        // Cache is enabled by default — checkbox must be checked
        await expect(webview.locator('#chk-cache-enabled')).toBeChecked();
        await expect(webview.locator('#select-interval')).toBeVisible();
        // Sync Now button is enabled when cache is enabled and not running
        await expect(webview.locator('#btn-trigger-sync')).toBeEnabled();
        await expect(webview.locator('#btn-trigger-sync')).toContainText('Sync Now');
        // Sync status row shows "Last sync: Never" as the initial value
        await expect(webview.locator('.sync-status-row')).toContainText('Last sync');
        await expect(webview.locator('.sync-status-row')).toContainText('Never');
        // Auto-open browser pref badge shows "off by default" (disabled by default)
        await expect(
          webview.locator('label.pref-row:has(#chk-open-browser) .pref-state-badge.pref-state-off'),
        ).toContainText('off by default');
        await expect(
          webview.locator('label.pref-row:has(#chk-breakpoint-snapshot-handling) .pref-state-badge.pref-state-off'),
        ).toContainText('off by default');
        // Branch auto-checkout carries an "experimental" badge
        await expect(webview.locator('.beta-badge')).toBeVisible();
        // Debug behavior contains exactly three preference toggles
        await expect(webview.locator('.pref-row .toggle-switch')).toHaveCount(3);
        // Navigation buttons
        await expect(webview.locator('#btn-back-settings')).toBeVisible();
        await expect(webview.locator('#btn-logout-settings')).toBeVisible();

        await webview.locator('#btn-back-settings').click();

        await expectReadyScreen(webview);
        await expect(webview.getByText('mock-service-a')).toBeVisible();
      });
    });

    test('User can enable auto-open browser on attach from Settings and return to the launcher', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        const openBrowserToggle = webview.locator('#chk-open-browser');
        await expect(openBrowserToggle).not.toBeChecked();

        await openBrowserToggle.check({ force: true });
        await expect(openBrowserToggle).toBeChecked();
        await expect(webview.locator('label.pref-row:has(#chk-open-browser) .toggle-switch')).toHaveClass(/on/);
        await expect(webview.locator('label.pref-row:has(#chk-open-browser) .pref-state-badge.pref-state-on')).toContainText('enabled');
        await expect.poll(async () => {
          await postExtensionMessage(webview, { type: 'GET_DEBUG_PREFS' });
          return webview.locator('#chk-open-browser').isChecked();
        }).toBe(true);

        await webview.locator('#btn-back-settings').click();
        await expectReadyScreen(webview);
        await expect(webview.locator('.active-card')).toHaveCount(0);
        await expect(webview.locator('#btn-start-debug')).toBeDisabled();
      });
    });

    test('Breakpoint snapshot handling toggle can be enabled and persists after reopening settings', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);
        await expect(webview.locator('#btn-open-breakpoint-snapshots')).toHaveCount(0);

        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        await expect(webview.locator('#chk-breakpoint-snapshot-handling')).not.toBeChecked();

        await webview.locator('#chk-breakpoint-snapshot-handling').check({ force: true });
        await expect(webview.locator('#chk-breakpoint-snapshot-handling')).toBeChecked();
        await expect(
          webview.locator('label.pref-row:has(#chk-breakpoint-snapshot-handling) .toggle-switch'),
        ).toHaveClass(/on/);
        // Let SAVE_DEBUG_PREFS round-trip complete before leaving Settings.
        await delay(300);

        await webview.locator('#btn-back-settings').click();
        await expectReadyScreen(webview);
        await expect(webview.locator('#btn-open-breakpoint-snapshots')).toBeVisible();
        await webview.locator('#btn-gear').click();

        await expect(webview.getByText('Settings')).toBeVisible();
        await expect(webview.locator('#chk-breakpoint-snapshot-handling')).toBeChecked();
      });
    });
  });

  // ─── Select Folder Screen ──────────────────────────────────────────────────

  test.describe('Select Folder Screen', () => {
    test('Save and Continue is disabled until a folder path is selected', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await goToFolderSelection(webview);

        // Verify all SELECT_FOLDER screen structural elements
        await expect(webview.locator('.step-badge', { hasText: '3/3' })).toBeVisible();
        // Info box shows the selected org
        await expect(webview.locator('.info-box', { hasText: 'mock-org-alpha' })).toBeVisible();
        await expect(webview.locator('.section-label', { hasText: 'Local Group Folder' })).toBeVisible();
        // No folder selected yet — placeholder text shown
        await expect(webview.getByText('No folder selected yet.')).toBeVisible();
        await expect(webview.locator('#btn-browse-folder')).toBeVisible();
        await expect(webview.locator('#btn-back-select-org')).toBeVisible();
        // No folder yet — Save button disabled
        await expectButtonDisabled(webview.locator('#btn-save-mapping'));

        // Inject a folder path — Save button becomes enabled
        await injectSelectedFolder(webview, MOCK_GROUP_FOLDER);
        await expect(webview.getByText(MOCK_GROUP_FOLDER)).toBeVisible();
        await expectButtonEnabled(webview.locator('#btn-save-mapping'));
      });
    });
  });

  // ─── Preparing Branches Screen ────────────────────────────────────────────

  test.describe('Preparing Branches Screen', () => {
    test('BRANCH_PREP_START shows prep screen with service rows, branch badges, and step updates', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Inject BRANCH_PREP_START — transitions to PREPARING_BRANCHES screen
        await injectMessage(webview, {
          type: 'BRANCH_PREP_START',
          payload: {
            services: [
              { appName: 'mock-service-a', targetBranch: 'main', currentBranch: 'feature/x' },
              { appName: 'mock-service-c', targetBranch: 'develop', currentBranch: 'feature/x' },
            ],
          },
        });

        // Verify PREPARING_BRANCHES screen structural elements
        await expect(webview.getByText('Preparing Branches')).toBeVisible({ timeout: 3_000 });
        // Initial status block while services are still running
        await expect(webview.locator('.info-box', { hasText: 'Preparing branch environment' })).toBeVisible();

        // Both service rows are visible with correct branch badges
        const serviceARow = webview.locator('.prep-row', { hasText: 'mock-service-a' });
        const serviceCRow = webview.locator('.prep-row', { hasText: 'mock-service-c' });
        await expect(serviceARow).toBeVisible();
        await expect(serviceCRow).toBeVisible();
        await expect(webview.locator('.branch-badge', { hasText: 'main' })).toBeVisible();
        await expect(webview.locator('.branch-badge', { hasText: 'develop' })).toBeVisible();

        // Initial step is 'pending' — spinner + "Preparing…" status text
        await expect(serviceARow.locator('.spinner')).toBeVisible();
        await expect(serviceARow.locator('.prep-status-text')).toContainText('Preparing');

        // Step update: stashing — text changes
        await injectMessage(webview, {
          type: 'BRANCH_PREP_STATUS',
          payload: { appName: 'mock-service-a', step: 'stashing' },
        });
        await expect(serviceARow.locator('.prep-status-text')).toContainText('Stashing', { timeout: 3_000 });

        // Step update: done — check-mark icon + "Ready" text
        await injectMessage(webview, {
          type: 'BRANCH_PREP_STATUS',
          payload: { appName: 'mock-service-a', step: 'done' },
        });
        await expect(serviceARow.locator('.prep-icon-ok')).toBeVisible({ timeout: 3_000 });
        await expect(serviceARow.locator('.prep-status-text')).toContainText('Ready', { timeout: 3_000 });

        // Step update: error — error icon + custom message
        await injectMessage(webview, {
          type: 'BRANCH_PREP_STATUS',
          payload: { appName: 'mock-service-c', step: 'error', message: 'Branch checkout failed' },
        });
        await expect(serviceCRow.locator('.prep-icon-err')).toBeVisible({ timeout: 3_000 });
        await expect(serviceCRow.locator('.prep-status-text')).toContainText('Branch checkout failed', { timeout: 3_000 });

        // All services done with at least one error → status block changes
        await expect(webview.locator('.info-box', { hasText: 'Some services failed' })).toBeVisible({ timeout: 3_000 });
      });
    });

    test('BRANCH_PREP_START with empty services shows "No services to prepare" placeholder', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Empty services array — edge case that should render the empty-list placeholder
        await injectMessage(webview, {
          type: 'BRANCH_PREP_START',
          payload: { services: [] },
        });

        await expect(webview.getByText('Preparing Branches')).toBeVisible({ timeout: 3_000 });
        // Empty prep list shows placeholder inside .prep-list container
        await expect(webview.locator('.prep-list')).toBeVisible();
        await expect(webview.locator('.org-list-empty', { hasText: 'No services to prepare.' })).toBeVisible();
        // Status block still shows "Preparing" (allDone is false when services is empty)
        await expect(webview.locator('.info-box', { hasText: 'Preparing branch environment' })).toBeVisible();
      });
    });

    test('DEBUG_CONNECTING from PREPARING_BRANCHES screen transitions to READY with session card', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'BRANCH_PREP_START',
          payload: {
            services: [
              { appName: 'mock-service-a', targetBranch: 'main', currentBranch: 'feature/x' },
            ],
          },
        });
        await expect(webview.getByText('Preparing Branches')).toBeVisible({ timeout: 3_000 });

        // DEBUG_CONNECTING from prep screen: state changes to READY and session card appears
        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });

        await expectReadyScreen(webview);
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible({ timeout: 3_000 });
        // Prep screen elements are cleared
        await expect(webview.locator('.prep-row')).toHaveCount(0);
        await expect(webview.getByText('Preparing Branches')).toHaveCount(0);
      });
    });

    test('BRANCH_PREP_STATUS checking-out, installing, building, and skipped steps render correctly', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'BRANCH_PREP_START',
          payload: {
            services: [
              { appName: 'mock-service-a', targetBranch: 'main', currentBranch: 'feature/x' },
              { appName: 'mock-service-b', targetBranch: 'main', currentBranch: 'main' },
              { appName: 'mock-service-c', targetBranch: 'develop', currentBranch: 'feature/x' },
            ],
          },
        });
        await expect(webview.getByText('Preparing Branches')).toBeVisible({ timeout: 3_000 });

        // Verify prep-row structural elements: .prep-row-top (name + badge), .prep-row-status (icon + text)
        const serviceARow = webview.locator('.prep-row', { hasText: 'mock-service-a' });
        await expect(serviceARow.locator('.prep-row-top')).toBeVisible();
        await expect(serviceARow.locator('.prep-name')).toContainText('mock-service-a');
        await expect(serviceARow.locator('.prep-row-status')).toBeVisible();

        // checking-out step: spinner + "Checking out branch…"
        await injectMessage(webview, {
          type: 'BRANCH_PREP_STATUS',
          payload: { appName: 'mock-service-a', step: 'checking-out', targetBranch: 'main' },
        });
        await expect(serviceARow.locator('.spinner')).toBeVisible({ timeout: 3_000 });
        await expect(serviceARow.locator('.prep-status-text')).toContainText('Checking out branch', { timeout: 3_000 });

        // installing step: spinner + "Running pnpm install…"
        await injectMessage(webview, {
          type: 'BRANCH_PREP_STATUS',
          payload: { appName: 'mock-service-a', step: 'installing' },
        });
        await expect(serviceARow.locator('.prep-status-text')).toContainText('pnpm install', { timeout: 3_000 });

        // building step: spinner + "Running pnpm build…"
        await injectMessage(webview, {
          type: 'BRANCH_PREP_STATUS',
          payload: { appName: 'mock-service-a', step: 'building' },
        });
        await expect(serviceARow.locator('.prep-status-text')).toContainText('pnpm build', { timeout: 3_000 });

        // skipped step: dash icon (.prep-icon-skip) + "No branch change needed" default message
        const serviceBRow = webview.locator('.prep-row', { hasText: 'mock-service-b' });
        await injectMessage(webview, {
          type: 'BRANCH_PREP_STATUS',
          payload: { appName: 'mock-service-b', step: 'skipped' },
        });
        await expect(serviceBRow.locator('.prep-icon-skip')).toBeVisible({ timeout: 3_000 });
        await expect(serviceBRow.locator('.prep-status-text')).toContainText('No branch change needed', { timeout: 3_000 });
      });
    });

    test('BRANCH_PREP all done without errors shows "Starting debug sessions" status with spinner', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await injectMessage(webview, {
          type: 'BRANCH_PREP_START',
          payload: {
            services: [
              { appName: 'mock-service-a', targetBranch: 'main', currentBranch: 'feature/x' },
            ],
          },
        });
        await expect(webview.getByText('Preparing Branches')).toBeVisible({ timeout: 3_000 });

        // Mark the single service as done (no errors)
        await injectMessage(webview, {
          type: 'BRANCH_PREP_STATUS',
          payload: { appName: 'mock-service-a', step: 'done' },
        });

        // All done, no errors → "Starting debug sessions…" with spinner in status block
        await expect(webview.locator('.info-box', { hasText: 'Starting debug sessions' })).toBeVisible({ timeout: 3_000 });
        await expect(webview.locator('.info-box .spinner')).toBeVisible({ timeout: 3_000 });
      });
    });
  });

  // ─── Setup Credentials Screen ──────────────────────────────────────────────

  test.describe('Setup Credentials Screen', () => {
    test('CREDENTIALS_ERROR shows error box and re-enables save button', async () => {
      await withVsCodeSession({ credentialMode: 'none', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await expectSetupCredentialsScreen(webview);

        // Inject CREDENTIALS_ERROR directly — simulates keychain storage failure
        // (no save click needed: screen check passes since we're already on SETUP_CREDENTIALS)
        await injectMessage(webview, {
          type: 'CREDENTIALS_ERROR',
          payload: { message: 'Keychain access denied — please unlock your keychain' },
        });

        // Error box appears with the message
        await expect(webview.locator('.error-box')).toContainText('Keychain access denied');
        // Save button is re-enabled after error (isSavingCreds=false)
        await expect(webview.locator('#btn-save-creds')).toBeEnabled();
        // Still on credentials screen — all form elements remain
        await expectSetupCredentialsScreen(webview);
      });
    });

    test('Update mode shows "Update Credentials" title, cancel button, and no env hint', async () => {
      // Navigate: READY → Settings with a keychain credential override → click Update Credentials
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await setCredentialStatusOverride(webview, {
          hasCredentials: true,
          email: 'user@keychain.com',
          source: 'keychain',
        });
        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        await expect.poll(async () => {
          await refreshCredentialStatus(webview);
          return webview.locator('#btn-update-credentials').isVisible();
        }).toBe(true);
        await expect(webview.locator('#btn-update-credentials')).toBeVisible();

        // Enter update mode
        await webview.locator('#btn-update-credentials').click();

        // Update mode UI: title is "Update Credentials", not "Setup Credentials"
        await expect(webview.getByText('Update Credentials')).toBeVisible();
        // Back to Settings cancel button is present in update mode
        await expect(webview.locator('#btn-cancel-creds')).toBeVisible();
        // env-var hint is NOT shown in update mode (only in initial setup mode)
        await expect(webview.locator('.cred-env-hint')).toHaveCount(0);
        // Core credential form elements are present
        await expect(webview.locator('.info-box', { hasText: /keychain/i })).toBeVisible();
        await expect(webview.getByPlaceholder('your.name@company.com')).toBeVisible();
        await expect(webview.getByPlaceholder('Password')).toBeVisible();
        await expect(webview.locator('#btn-toggle-pwd')).toBeVisible();
        // Save button says "Update & Continue"
        await expect(webview.getByRole('button', { name: 'Update & Continue' })).toBeVisible();

        // Cancel returns to Settings
        await webview.locator('#btn-cancel-creds').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        await clearCredentialStatusOverride(webview);
      });
    });

    test('CREDENTIALS_REVOKED forces setup screen with the revocation error message', async () => {
      // Scenario: extension detects that keychain credentials are revoked during a login attempt
      // and clears them, then sends CREDENTIALS_REVOKED to force the user to re-enter creds.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Inject CREDENTIALS_REVOKED — extension has already cleared the stored creds
        await injectMessage(webview, {
          type: 'CREDENTIALS_REVOKED',
          payload: { message: 'SAP credentials are no longer valid. Please update them.' },
        });

        // Must redirect to SETUP_CREDENTIALS screen regardless of current screen
        await expectSetupCredentialsScreen(webview);
        // Error message from the revocation event must appear in the error box
        await expect(webview.locator('.error-box')).toContainText('SAP credentials are no longer valid');
        // Handler sets hasCredentials=false → isUpdate=false → setup mode (not update mode)
        // Heading must be "Setup Credentials" (not "Update Credentials")
        await expect(webview.getByText('Setup Credentials')).toBeVisible();
        // Setup mode: env hint IS visible, no cancel button
        await expect(webview.locator('.cred-env-hint')).toBeVisible();
        await expect(webview.locator('#btn-cancel-creds')).toHaveCount(0);
        await expect(webview.locator('#btn-save-creds')).toBeEnabled();
      });
    });

    test('CREDENTIALS_STATUS with hasCredentials=false forces redirect to setup screen', async () => {
      // Scenario: extension sends CREDENTIALS_STATUS after the user clears credentials via
      // #btn-clear-credentials in Settings. The webview must redirect to SETUP_CREDENTIALS
      // because prevHad=true and new hasCredentials=false.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await webview.locator('#btn-gear').click();
        await expect(webview.getByText('Settings')).toBeVisible();
        // Wait for the extension's own credential status push (env mode) — establishes prevHad=true
        await expect(webview.locator('.cred-source-badge.env')).toBeVisible();

        // Extension clears credentials → sends CREDENTIALS_STATUS { hasCredentials: false }
        // prevHad=true + new=false triggers the forced SETUP_CREDENTIALS redirect path
        await injectMessage(webview, {
          type: 'CREDENTIALS_STATUS',
          payload: { hasCredentials: false, email: '', source: 'none' },
        });

        // Should redirect to SETUP_CREDENTIALS setup mode (not stay on Settings)
        await expectSetupCredentialsScreen(webview);
        await expect(webview.getByText('Setup Credentials')).toBeVisible();
        // Setup mode: env hint visible, no cancel button (fresh setup, no prior creds)
        await expect(webview.locator('.cred-env-hint')).toBeVisible();
        await expect(webview.locator('#btn-cancel-creds')).toHaveCount(0);
        // No error box — this is a clean credential-clear, not an error
        await expect(webview.locator('.error-box')).toHaveCount(0);
      });
    });

    test('Successful credential save without prior mappings navigates to the Region screen', async () => {
      await withVsCodeSession({ credentialMode: 'none', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await expectSetupCredentialsScreen(webview);

        // Enter valid credentials and save
        await webview.getByPlaceholder('your.name@company.com').fill('user@example.com');
        await webview.getByPlaceholder('Password').fill('valid-password-123');
        await webview.getByRole('button', { name: /Save & Continue/ }).click();
        const saveButton = webview.locator('#btn-save-creds');
        const regionHeading = webview.getByText('CF Region');
        // Two valid paths:
        // 1) UI stays in setup briefly with Saving state.
        // 2) Extension saves instantly and transitions to Region before the check.
        await Promise.any([
          (async () => {
            await expect(saveButton).toBeVisible({ timeout: 2_500 });
            await expect(saveButton).toBeDisabled({ timeout: 2_500 });
            await expect(saveButton).toContainText('Saving', { timeout: 2_500 });
          })(),
          expect(regionHeading).toBeVisible({ timeout: 2_500 }),
        ]).catch(() => undefined);

        // Inject CREDENTIALS_SAVED to simulate the extension completing the save.
        // This bypasses SecretStorage which is unavailable on headless Linux CI
        // (no GNOME Keyring). The test still exercises the full UI transition path.
        if (!(await regionHeading.isVisible())) {
          await injectMessage(webview, {
            type: 'CREDENTIALS_SAVED',
            payload: { email: 'user@example.com', source: 'keychain' },
          });
        }

        // No mappings → REGION screen
        await expectRegionScreen(webview);
      });
    });
  });

  // ─── Org-Folder Caching ────────────────────────────────────────────────────

  test.describe('Org-Folder Caching', () => {
    const MOCK_GROUP_FOLDER_BETA = '/tmp/cds-debug-e2e-group-beta';

    test('Cached folder is auto-restored when re-selecting a previously mapped org', async () => {
      // Verifies that after completing the full mapping flow for an org, navigating back
      // to SELECT_FOLDER for the same org auto-fills the previously chosen folder path.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        // Complete the full setup for mock-org-alpha with MOCK_GROUP_FOLDER
        await completeMappingToReady(webview);

        // Remap: no active sessions so btn-remap goes directly to SELECT_ORG
        await webview.locator('#btn-remap').click();
        await expect(webview.getByText('Select CF Org')).toBeVisible({ timeout: 5_000 });

        // Re-select mock-org-alpha (the org that was already mapped)
        await webview.locator('input[name="cf-org"][value="mock-org-alpha"]').check({ force: true });
        await webview.locator('#btn-next-org').click();

        // SELECT_FOLDER must show the previously chosen folder path — no Browse required
        await expect(webview.getByText('Select Local Folder')).toBeVisible();
        await expect(webview.getByText(MOCK_GROUP_FOLDER)).toBeVisible();
        // Save button is enabled because the cached folder was auto-restored
        await expectButtonEnabled(webview.locator('#btn-save-mapping'));
        // Browse button still present — user can override the cached folder
        await expect(webview.locator('#btn-browse-folder')).toBeVisible();
      });
    });

    test('Different orgs retain independent cached folder paths', async () => {
      // Full round-trip: map org-alpha → folder-alpha, then map org-beta → folder-beta,
      // then switch between both orgs and verify each still shows its own cached folder.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);

        // Step 1: complete mapping for mock-org-alpha with MOCK_GROUP_FOLDER
        await completeMappingToReady(webview);

        // Step 2: remap → SELECT_ORG → select org-beta → folder screen has no cached path
        await webview.locator('#btn-remap').click();
        await expect(webview.getByText('Select CF Org')).toBeVisible({ timeout: 5_000 });
        await webview.locator('input[name="cf-org"][value="mock-org-beta"]').check({ force: true });
        await webview.locator('#btn-next-org').click();
        await expect(webview.getByText('Select Local Folder')).toBeVisible();
        // org-beta has never been mapped → no pre-fill
        await expect(webview.getByText('No folder selected yet.')).toBeVisible();
        await expectButtonDisabled(webview.locator('#btn-save-mapping'));

        // Step 3: select folder-beta and complete mapping for org-beta
        await injectSelectedFolder(webview, MOCK_GROUP_FOLDER_BETA);
        await expect(webview.getByText(MOCK_GROUP_FOLDER_BETA)).toBeVisible();
        await webview.locator('#btn-save-mapping').click();
        await expectReadyScreen(webview);

        // Step 4: remap → SELECT_ORG → switch back to org-alpha → folder-alpha pre-filled
        await webview.locator('#btn-remap').click();
        await expect(webview.getByText('Select CF Org')).toBeVisible({ timeout: 5_000 });
        await webview.locator('input[name="cf-org"][value="mock-org-alpha"]').check({ force: true });
        await webview.locator('#btn-next-org').click();
        await expect(webview.getByText('Select Local Folder')).toBeVisible();
        await expect(webview.getByText(MOCK_GROUP_FOLDER)).toBeVisible();
        await expectButtonEnabled(webview.locator('#btn-save-mapping'));

        // Step 5: go back → SELECT_ORG → switch to org-beta → folder-beta pre-filled
        await webview.locator('#btn-back-select-org').click();
        await expect(webview.getByText('Select CF Org')).toBeVisible();
        await webview.locator('input[name="cf-org"][value="mock-org-beta"]').check({ force: true });
        await webview.locator('#btn-next-org').click();
        await expect(webview.getByText('Select Local Folder')).toBeVisible();
        await expect(webview.getByText(MOCK_GROUP_FOLDER_BETA)).toBeVisible();
        await expectButtonEnabled(webview.locator('#btn-save-mapping'));
      });
    });

    test('User can override the cached folder by clicking Browse', async () => {
      // Verify that a cached folder is shown as default but can be replaced by
      // injecting a new GROUP_FOLDER_SELECTED (simulating the native file picker).
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Remap → select same org → folder is pre-filled with cached path
        await webview.locator('#btn-remap').click();
        await expect(webview.getByText('Select CF Org')).toBeVisible({ timeout: 5_000 });
        await webview.locator('input[name="cf-org"][value="mock-org-alpha"]').check({ force: true });
        await webview.locator('#btn-next-org').click();
        await expect(webview.getByText('Select Local Folder')).toBeVisible();
        await expect(webview.getByText(MOCK_GROUP_FOLDER)).toBeVisible();

        // Simulate Browse: inject a different folder path
        const overriddenFolder = '/tmp/cds-debug-e2e-override';
        await injectSelectedFolder(webview, overriddenFolder);

        // Overridden folder replaces the cached one in the UI
        await expect(webview.getByText(overriddenFolder)).toBeVisible();
        await expect(webview.getByText(MOCK_GROUP_FOLDER)).toHaveCount(0);
        // Save is still enabled (new path is valid)
        await expectButtonEnabled(webview.locator('#btn-save-mapping'));
      });
    });

    test('CONFIG_LOADED with multiple org mappings pre-populates folder cache for all orgs', async () => {
      // Simulates VS Code restart where two orgs were previously mapped.
      // CONFIG_LOADED populates the target folder cache for both; navigating to either org's
      // SELECT_FOLDER screen must show its persisted folder without any Browse interaction.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await expectRegionScreen(webview);

        // Inject CONFIG_LOADED with two pre-existing org mappings.
        // Depending on CI timing, the real LOAD_APPS roundtrip may either leave
        // the webview on LOADING_APPS briefly or complete before we observe it.
        await injectMessage(webview, {
          type: 'CONFIG_LOADED',
          payload: {
            config: {
              apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
              orgs: ['mock-org-alpha', 'mock-org-beta'],
              orgGroupMappings: [
                { cfOrg: 'mock-org-alpha', groupFolderPath: '/cached/alpha' },
                { cfOrg: 'mock-org-beta', groupFolderPath: '/cached/beta' },
              ],
            },
            credentialStatus: { hasCredentials: true, email: MOCK_ENV_EMAIL, source: 'env' },
            activeSessions: {},
          },
        });

        await webview.waitForFunction(() => {
          return document.body?.textContent?.includes('Loading apps for') || !!document.getElementById('search-input');
        });

        const readyAfterRestore = await webview.locator('#search-input').isVisible();
        if (!readyAfterRestore) {
          await injectMessage(webview, {
            type: 'APPS_LOADED',
            payload: {
              apps: [
                { name: 'mock-service-a', state: 'started', urls: ['mock-service-a.cfapps.example.com'] },
                { name: 'mock-service-b', state: 'stopped', urls: [] },
                { name: 'mock-service-c', state: 'started', urls: ['mock-service-c.cfapps.example.com'] },
              ],
            },
          });
        }
        await expectReadyScreen(webview);

        // Remap → SELECT_ORG → select org-alpha → folder /cached/alpha is pre-filled
        await webview.locator('#btn-remap').click();
        await expect(webview.getByText('Select CF Org')).toBeVisible({ timeout: 5_000 });
        await webview.locator('input[name="cf-org"][value="mock-org-alpha"]').check({ force: true });
        await webview.locator('#btn-next-org').click();
        await expect(webview.getByText(/Loading spaces for/)).toBeVisible();
        await injectMessage(webview, { type: 'SPACES_LOADED', payload: { org: 'mock-org-alpha', spaces: ['app'] } });
        await expect(webview.getByText('Select Local Folder')).toBeVisible();
        await expect(webview.getByText('/cached/alpha')).toBeVisible();
        await expectButtonEnabled(webview.locator('#btn-save-mapping'));

        // Go back → SELECT_ORG → select org-beta → folder /cached/beta is pre-filled
        await webview.locator('#btn-back-select-org').click();
        await expect(webview.getByText('Select CF Org')).toBeVisible();
        await webview.locator('input[name="cf-org"][value="mock-org-beta"]').check({ force: true });
        await webview.locator('#btn-next-org').click();
        await expect(webview.getByText(/Loading spaces for/)).toBeVisible();
        await injectMessage(webview, { type: 'SPACES_LOADED', payload: { org: 'mock-org-beta', spaces: ['app'] } });
        await expect(webview.getByText('Select Local Folder')).toBeVisible();
        await expect(webview.getByText('/cached/beta')).toBeVisible();
        await expectButtonEnabled(webview.locator('#btn-save-mapping'));
      });
    });
  });
});
