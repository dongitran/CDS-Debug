import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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

type CredentialMode = 'env' | 'none';
type CfScenario = 'success' | 'auth-fail' | 'no-orgs' | 'apps-fail' | 'slow-auth' | 'slow-apps' | 'slow-target';

interface SessionOptions {
  credentialMode: CredentialMode;
  cfScenario: CfScenario;
}

interface SessionArtifacts {
  appProcess?: ChildProcessWithoutNullStreams;
  browser?: Browser;
  workbenchPage?: Page;
  userDataDir: string;
  extensionsDir: string;
  mockBinDir: string;
}

const MOCK_ENV_EMAIL = 'e2e.mock.user@example.com';
const MOCK_ENV_PASSWORD = 'e2e-mock-password';
const MOCK_GROUP_FOLDER = '/tmp/cds-debug-e2e-group';
const WEBSOCKET_TIMEOUT_MS = 90_000;
const FRAME_TIMEOUT_MS = 90_000;

function buildMockCfScript(scenario: CfScenario): string {
  return `#!/usr/bin/env bash
set -euo pipefail

SCENARIO="${scenario}"
cmd="\${1:-}"

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
  target)
    if [[ "$SCENARIO" == "slow-target" ]]; then
      sleep 30
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

function buildVsCodeEnv(mockBinDir: string, credentialMode: CredentialMode): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH ?? '';
  const credentials = credentialMode === 'env'
    ? { SAP_EMAIL: MOCK_ENV_EMAIL, SAP_PASSWORD: MOCK_ENV_PASSWORD }
    : { SAP_EMAIL: '', SAP_PASSWORD: '' };

  return {
    ...process.env,
    ...credentials,
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
    repoRoot,
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
  const markers = ['CF Region', 'Login to Cloud Foundry', 'Setup Credentials'];
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

async function createSessionArtifacts(options: SessionOptions): Promise<SessionArtifacts> {
  const userDataDir = await createTempDirectory('cds-debug-e2e-user-');
  const extensionsDir = await createTempDirectory('cds-debug-e2e-extensions-');
  const mockBinDir = await createTempDirectory('cds-debug-e2e-bin-');
  await createMockCfCli(mockBinDir, options.cfScenario);

  return {
    userDataDir,
    extensionsDir,
    mockBinDir,
  };
}

async function withVsCodeSession(
  options: SessionOptions,
  run: (workbenchPage: Page) => Promise<void>,
): Promise<void> {
  const repoRoot = resolve(process.cwd(), '..');
  const cdpPort = await allocatePort();
  const artifacts = await createSessionArtifacts(options);

  try {
    const env = buildVsCodeEnv(artifacts.mockBinDir, options.credentialMode);
    artifacts.appProcess = launchVsCode(
      repoRoot,
      artifacts.userDataDir,
      artifacts.extensionsDir,
      cdpPort,
      env,
    );

    await waitForCdpEndpoint(cdpPort, WEBSOCKET_TIMEOUT_MS);
    artifacts.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort.toString()}`);

    const context = artifacts.browser.contexts()[0];
    if (!context) {
      throw new Error('No browser context was created for VS Code.');
    }

    artifacts.workbenchPage = await waitForWorkbenchPage(context);
    await artifacts.workbenchPage.bringToFront();
    await run(artifacts.workbenchPage);
  } finally {
    if (artifacts.appProcess) {
      await terminateProcess(artifacts.appProcess, artifacts.browser, artifacts.workbenchPage);
    }

    if (artifacts.browser) {
      await artifacts.browser.close().catch(() => undefined);
    }

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
  await expect(webview.getByRole('button', { name: 'Login to Cloud Foundry' })).toBeVisible();
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

async function completeMappingToReady(webview: Frame): Promise<void> {
  await goToFolderSelection(webview);
  await injectSelectedFolder(webview, MOCK_GROUP_FOLDER);
  await expect(webview.getByText(MOCK_GROUP_FOLDER)).toBeVisible();
  await webview.locator('#btn-save-mapping').click();
  await expect(webview.getByText('Debug Launcher')).toBeVisible();
  await expect(webview.locator('#search-input')).toBeVisible();
}

async function expectButtonDisabled(button: Locator): Promise<void> {
  await expect(button).toBeDisabled();
}

async function expectButtonEnabled(button: Locator): Promise<void> {
  await expect(button).toBeEnabled();
}

test.describe('CDS Debug Onboarding and Launcher E2E', () => {
  test('User can login and see mocked org list', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await goToOrgSelection(webview);

      // Verify all SELECT_ORG screen structural elements
      await expect(webview.locator('.step-badge', { hasText: '2/3' })).toBeVisible();
      await expect(webview.locator('.info-box', { hasText: 'Choose the Cloud Foundry org you want to debug.' })).toBeVisible();
      await expect(webview.locator('.section-label', { hasText: 'CF Org' })).toBeVisible();
      // Next button disabled until an org is selected
      await expect(webview.locator('#btn-next-org')).toBeDisabled();
      await expect(webview.locator('#btn-back-region')).toBeVisible();
      await expect(webview.getByText('mock-org-alpha')).toBeVisible();
      await expect(webview.getByText('mock-org-beta')).toBeVisible();
    });
  });

  test('User can see setup screen when credentials are missing', async () => {
    await withVsCodeSession({ credentialMode: 'none', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectSetupCredentialsScreen(webview);
      // Setup mode: env-var hint shown, no "Back to Settings" button
      await expect(webview.locator('.cred-env-hint')).toBeVisible();
      await expect(webview.locator('.cred-env-hint')).toContainText('SAP_EMAIL');
      await expect(webview.locator('.cred-env-hint')).toContainText('SAP_PASSWORD');
      await expect(webview.locator('#btn-cancel-creds')).toHaveCount(0);
    });
  });

  test('User can see setup credential validation errors', async () => {
    await withVsCodeSession({ credentialMode: 'none', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectSetupCredentialsScreen(webview);

      const saveButton = webview.getByRole('button', { name: /Save & Continue|Update & Continue/ });

      await saveButton.click();
      await expect(webview.getByText('Email is required.')).toBeVisible();

      await webview.getByPlaceholder('your.name@company.com').fill('invalid-email');
      await saveButton.click();
      await expect(webview.getByText('Please enter a valid email address.')).toBeVisible();

      await webview.getByPlaceholder('your.name@company.com').fill('valid.user@example.com');
      await saveButton.click();
      await expect(webview.getByText('Password is required.')).toBeVisible();
    });
  });

  test('User can see non-https endpoint validation error', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await webview.locator('input[name="cf-region"][value="custom"]').check({ force: true });
      await webview.locator('#api-endpoint-custom').fill('http://api.cf.invalid.hana.ondemand.com');

      await loginFromRegionScreen(webview);
      await expect(webview.getByText('API endpoint must start with https://')).toBeVisible();
      await expectRegionScreen(webview);
    });
  });

  test('User can login with a valid custom endpoint', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await webview.locator('input[name="cf-region"][value="custom"]').check({ force: true });
      await webview.locator('#api-endpoint-custom').fill('https://api.cf.us10.hana.ondemand.com');

      await loginFromRegionScreen(webview);
      await expect(webview.getByText('Select CF Org')).toBeVisible();
      await expect(webview.getByText('mock-org-alpha')).toBeVisible();
    });
  });

  test('User can see login error when CF auth fails', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'auth-fail' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await loginFromRegionScreen(webview);
      await expect(webview.getByText(/mock auth failed|Command failed|authentication failed/i)).toBeVisible();
      await expectRegionScreen(webview);
    });
  });

  test('User can cancel login and return to region screen', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-auth' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await loginFromRegionScreen(webview);
      // Verify all LOGGING_IN screen elements: spinner, heading, endpoint URL, cancel button
      await expect(webview.locator('.spinner')).toBeVisible();
      await expect(webview.getByText(/Logging in/)).toBeVisible();
      await expect(webview.locator('.radio-desc', { hasText: 'api.cf.eu10.hana.ondemand.com' })).toBeVisible();
      await expect(webview.locator('#btn-cancel-login')).toBeVisible();
      await webview.locator('#btn-cancel-login').click();

      await expectRegionScreen(webview);
      await expect(webview.locator('#btn-cancel-login')).toHaveCount(0);
    });
  });

  test('User can see empty-org state when org list is empty', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'no-orgs' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await goToOrgSelection(webview);

      const nextButton = webview.locator('#btn-next-org');
      await expect(webview.getByText('No orgs found.')).toBeVisible();
      await expectButtonDisabled(nextButton);

      await webview.locator('#btn-back-region').click();
      await expectRegionScreen(webview);
    });
  });

  test('User can navigate org selection and go back to region', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectRegionScreen(webview);

      await loginFromRegionScreen(webview);
      await expect(webview.getByText('Select CF Org')).toBeVisible();

      await webview.locator('input[name="cf-org"][value="mock-org-beta"]').check({ force: true });
      await webview.locator('#btn-next-org').click();

      await expect(webview.getByText('Select Local Folder')).toBeVisible();
      await expect(webview.getByRole('button', { name: /Browse/i })).toBeVisible();

      await webview.locator('#btn-back-select-org').click();
      await expect(webview.getByText('Select CF Org')).toBeVisible();

      await webview.locator('#btn-back-region').click();
      await expectRegionScreen(webview);
    });
  });

  test('User can complete mapping flow and reach ready screen', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await completeMappingToReady(webview);

      // Verify all READY screen structural elements
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
      await expect(webview.getByText('mock-service-a')).toBeVisible();
      await expect(webview.getByText('mock-service-b')).toBeVisible();
      await expect(webview.getByText('mock-service-c')).toBeVisible();
    });
  });

  test('User can filter and select started apps in ready screen', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await completeMappingToReady(webview);

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

      await webview.locator('#chk-select-all').uncheck();
      await expectButtonDisabled(startButton);

      // Search for a name that matches no app → "No apps found" empty state
      await webview.locator('#search-input').fill('zzz-nonexistent-app');
      await expect(webview.locator('.app-list')).toContainText('No apps found');
    });
  });

  test('User can see apps-load error and retry affordance', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'apps-fail' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await goToFolderSelection(webview);
      await injectSelectedFolder(webview, MOCK_GROUP_FOLDER);

      await webview.locator('#btn-save-mapping').click();
      await expect(webview.locator('.error-box')).toContainText(/mock apps load failed|Command failed/i);
      await expect(webview.getByRole('button', { name: /Retry/i })).toBeVisible();
    });
  });

  test('User can cancel in-progress app loading and return to folder screen', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-apps' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await goToFolderSelection(webview);
      await injectSelectedFolder(webview, MOCK_GROUP_FOLDER);

      await webview.locator('#btn-save-mapping').click();
      await expect(webview.getByText(/Loading apps for/i)).toBeVisible();
      // Verify all LOADING_APPS screen elements: spinner and cancel button
      await expect(webview.locator('.spinner')).toBeVisible();
      await expect(webview.locator('#btn-cancel-load-apps')).toBeVisible();
      await webview.locator('#btn-cancel-load-apps').click();

      await expect(webview.getByText('Select Local Folder')).toBeVisible();
      await expect(webview.getByRole('button', { name: /Save & Continue/i })).toBeVisible();
    });
  });

  test('User can open settings from ready and logout back to region', async () => {
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await completeMappingToReady(webview);

      await webview.locator('#btn-gear').click();
      await expect(webview.getByText('Settings')).toBeVisible();
      await expect(webview.getByText('SAP Credentials')).toBeVisible();

      await webview.locator('#btn-logout-settings').click();
      await expectRegionScreen(webview);
    });
  });

  test('Clicking Start Debug Sessions shows pending sessions immediately (optimistic UI)', async () => {
    // Uses slow-target so cfTarget() blocks in the extension while we assert the
    // optimistic PENDING state that should appear in the UI before DEBUG_CONNECTING.
    await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-target' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await completeMappingToReady(webview);

      // Select all started apps and start debug
      await webview.locator('#chk-select-all').check();
      await expectButtonEnabled(webview.locator('#btn-start-debug'));
      await webview.locator('#btn-start-debug').click();

      // Active session cards must appear immediately — before the slow cfTarget()
      // network call in the extension completes — verifying optimistic UI behavior.
      await expect(webview.locator('.active-card')).toHaveCount(2, { timeout: 3_000 });
      await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();
      await expect(webview.locator('.active-card', { hasText: 'mock-service-c' })).toBeVisible();

      // Apps should now be shown as disabled in the started list (no longer selectable)
      const serviceACheckbox = webview.locator('input[type="checkbox"][data-app="mock-service-a"]');
      const serviceCCheckbox = webview.locator('input[type="checkbox"][data-app="mock-service-c"]');
      await expect(serviceACheckbox).toBeDisabled({ timeout: 3_000 });
      await expect(serviceCCheckbox).toBeDisabled({ timeout: 3_000 });

      // Start button must be disabled since no more selectable started apps remain
      await expectButtonDisabled(webview.locator('#btn-start-debug'));
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

        // The stopped app row carries a "stopped" badge
        const stoppedRow = webview.locator('.app-row', { hasText: 'mock-service-b' });
        await expect(stoppedRow.locator('.badge-stopped')).toBeVisible();

        // App list shows both "Started" and "Stopped" section labels
        const appList = webview.locator('.app-list');
        await expect(appList.locator('.section-label', { hasText: 'Started' })).toBeVisible();
        await expect(appList.locator('.section-label', { hasText: 'Stopped' })).toBeVisible();
      });
    });

    test('CF info box shows region and org values', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        const cfInfoBox = webview.locator('.cf-info-box');
        await expect(cfInfoBox.locator('.cf-info-label', { hasText: 'Region' })).toBeVisible();
        // Default selected region is eu10
        await expect(cfInfoBox.locator('.cf-info-value', { hasText: 'eu10' })).toBeVisible();
        await expect(cfInfoBox.locator('.cf-info-label', { hasText: 'Org' })).toBeVisible();
        await expect(cfInfoBox.locator('.cf-info-value', { hasText: 'mock-org-alpha' })).toBeVisible();
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

        // After session: "debugging" badge and disabled checkbox
        await expect(serviceARow.locator('.badge-debug')).toBeVisible({ timeout: 3_000 });
        await expect(webview.locator('input[type="checkbox"][data-app="mock-service-a"]')).toBeDisabled({ timeout: 3_000 });

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
        await expect(activeCard.locator('.spinner')).toBeVisible();
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
        // Stop button present, no Open App or Retry buttons
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

    test('ATTACHED state with app URL shows Open App button and port in card title', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // mock-service-a has URL mock-service-a.cfapps.example.com in the mock CF output
        await injectMessage(webview, {
          type: 'DEBUG_CONNECTING',
          payload: { appNames: ['mock-service-a'], ports: { 'mock-service-a': 20000 } },
        });
        await expect(webview.locator('.active-card', { hasText: 'mock-service-a' })).toBeVisible();
        const activeCard = webview.locator('.active-card', { hasText: 'mock-service-a' });
        // Port shown in card title even in TUNNELING state
        await expect(activeCard.locator('.active-card-port')).toContainText(':20000');
        // No Open App button yet — only appears on ATTACHED
        await expect(activeCard.locator('.active-open-btn')).toHaveCount(0);

        await injectMessage(webview, {
          type: 'APP_DEBUG_STATUS',
          payload: { appName: 'mock-service-a', status: 'ATTACHED' },
        });

        // Open App button must appear now that app is ATTACHED and has a URL
        await expect(activeCard.locator('.active-open-btn')).toBeVisible({ timeout: 3_000 });
        await expect(activeCard.locator('.active-open-btn')).toContainText('Open App');
        // Stop button still present, no retry button (not ERROR)
        await expect(activeCard.locator('[data-stop-app="mock-service-a"]')).toBeVisible();
        await expect(activeCard.locator('[data-retry-app]')).toHaveCount(0);
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
      });
    });
  });

  // ─── Ready Screen — Actions and Navigation ─────────────────────────────────

  test.describe('Ready Screen — Actions and Navigation', () => {
    test('DEBUG_ERROR clears pending sessions and shows an error message', async () => {
      // Uses slow-target so cfTarget() blocks long enough for us to inject DEBUG_ERROR
      // before the extension has a chance to resolve the start request on its own.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-target' }, async (workbenchPage) => {
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
      });
    });

    test('Change Mapping with no active sessions returns to Select CF Org', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        await webview.locator('#btn-remap').click();

        await expect(webview.getByText('Select CF Org')).toBeVisible({ timeout: 5_000 });
        // Org list is rendered (previously logged-in orgs are preserved in state)
        await expect(webview.locator('input[name="cf-org"]')).not.toHaveCount(0);
      });
    });

    test('Cancel app loading returns to Ready screen when apps were previously loaded', async () => {
      // Uses slow-target so cfTarget blocks for 30 s on every LOAD_APPS call.
      // This gives a stable 30 s LOADING_APPS window after the refresh click,
      // long enough to assert all screen elements and click cancel before either
      // the first or second cfTarget process can complete and send APPS_LOADED.
      // force:true on the refresh click bypasses Playwright actionability checks
      // that can hang indefinitely when the webview DOM is briefly re-rendering.
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'slow-target' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await goToFolderSelection(webview);
        await injectSelectedFolder(webview, MOCK_GROUP_FOLDER);

        // Kick off the save (goes to LOADING_APPS; first cfTarget sleeps 30 s)
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
        await expect(webview.getByText('Debug Launcher')).toBeVisible();

        // Refresh — second cfTarget also sleeps 30 s, keeping LOADING_APPS stable.
        // force:true avoids an indefinite actionability-check hang caused by rapid
        // DOM replacement when the extension's success response races with the click.
        await webview.locator('#btn-refresh-apps').click({ force: true });
        await expect(webview.getByText(/Loading apps for/i)).toBeVisible({ timeout: 5_000 });
        await expect(webview.locator('.spinner')).toBeVisible({ timeout: 5_000 });
        await expect(webview.locator('#btn-cancel-load-apps')).toBeVisible({ timeout: 5_000 });

        // Cancel must navigate to READY (state.apps.length > 0), not SELECT_FOLDER
        await webview.locator('#btn-cancel-load-apps').click();
        await expect(webview.getByText('Debug Launcher')).toBeVisible({ timeout: 5_000 });
        await expect(webview.locator('#search-input')).toBeVisible();
        await expect(webview.getByText('mock-service-a')).toBeVisible();
        // No LOADING_APPS elements remain on READY
        await expect(webview.locator('#btn-cancel-load-apps')).toHaveCount(0);
      });
    });

    test('Refresh Apps reloads and re-displays the app list', async () => {
      await withVsCodeSession({ credentialMode: 'env', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await completeMappingToReady(webview);

        // Trigger a refresh — the extension re-fetches apps from CF
        await webview.locator('#btn-refresh-apps').click();

        // After reload, the ready screen returns with the same app list
        await expect(webview.getByText('Debug Launcher')).toBeVisible({ timeout: 10_000 });
        await expect(webview.locator('#search-input')).toBeVisible();
        await expect(webview.getByText('mock-service-a')).toBeVisible();
        await expect(webview.getByText('mock-service-b')).toBeVisible();
        await expect(webview.getByText('mock-service-c')).toBeVisible();
      });
    });
  });

  // ─── Settings Screen ───────────────────────────────────────────────────────

  test.describe('Settings Screen', () => {
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
        // Debug Behavior section with both preference toggles
        await expect(webview.locator('.section-label', { hasText: 'Debug Behavior' })).toBeVisible();
        await expect(webview.getByText(/Auto-open browser on attach/)).toBeVisible();
        await expect(webview.locator('#chk-open-browser')).toBeVisible();
        await expect(webview.getByText(/Branch auto-checkout/)).toBeVisible();
        await expect(webview.locator('#chk-branch-prep')).toBeVisible();
        // App Cache section with sync controls
        await expect(webview.locator('.section-label', { hasText: 'App Cache' })).toBeVisible();
        // Cache is enabled by default — checkbox must be checked
        await expect(webview.locator('#chk-cache-enabled')).toBeChecked();
        await expect(webview.locator('#select-interval')).toBeVisible();
        // Sync Now button is enabled when cache is enabled and not running
        await expect(webview.locator('#btn-trigger-sync')).toBeEnabled();
        // Sync status row shows "Last sync" with "Never" as the initial value
        await expect(webview.locator('.sync-status-row')).toContainText('Last sync');
        // Auto-open browser pref badge shows "off by default" (disabled by default)
        await expect(webview.locator('.pref-state-badge')).toContainText('off by default');
        // Navigation buttons
        await expect(webview.locator('#btn-back-settings')).toBeVisible();
        await expect(webview.locator('#btn-logout-settings')).toBeVisible();

        await webview.locator('#btn-back-settings').click();

        await expect(webview.getByText('Debug Launcher')).toBeVisible({ timeout: 5_000 });
        await expect(webview.locator('#search-input')).toBeVisible();
        await expect(webview.getByText('mock-service-a')).toBeVisible();
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
    test('Successful credential save without prior mappings navigates to the Region screen', async () => {
      await withVsCodeSession({ credentialMode: 'none', cfScenario: 'success' }, async (workbenchPage) => {
        const webview = await openCdsDebugWebview(workbenchPage);
        await expectSetupCredentialsScreen(webview);

        // Enter valid credentials and save
        await webview.getByPlaceholder('your.name@company.com').fill('user@example.com');
        await webview.getByPlaceholder('Password').fill('valid-password-123');
        await webview.getByRole('button', { name: /Save & Continue/ }).click();

        // Inject CREDENTIALS_SAVED to simulate the extension completing the save.
        // This bypasses SecretStorage which is unavailable on headless Linux CI
        // (no GNOME Keyring). The test still exercises the full UI transition path.
        await injectMessage(webview, {
          type: 'CREDENTIALS_SAVED',
          payload: { email: 'user@example.com', source: 'keychain' },
        });

        // No mappings → REGION screen
        await expectRegionScreen(webview);
      });
    });
  });
});
