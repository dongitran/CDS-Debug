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
type CfScenario = 'success' | 'auth-fail' | 'no-orgs' | 'apps-fail' | 'slow-auth' | 'slow-apps';

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
  await expect(webview.getByText('CF Region')).toBeVisible();
  await expect(webview.getByText('Select Region')).toBeVisible();
  await expect(webview.getByRole('button', { name: 'Login to Cloud Foundry' })).toBeVisible();
}

async function expectSetupCredentialsScreen(webview: Frame): Promise<void> {
  await expect(webview.getByText(/Setup Credentials|Update Credentials/)).toBeVisible();
  await expect(webview.getByPlaceholder('your.name@company.com')).toBeVisible();
  await expect(webview.getByPlaceholder('Password')).toBeVisible();
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
      await expect(webview.getByText('mock-org-alpha')).toBeVisible();
      await expect(webview.getByText('mock-org-beta')).toBeVisible();
    });
  });

  test('User can see setup screen when credentials are missing', async () => {
    await withVsCodeSession({ credentialMode: 'none', cfScenario: 'success' }, async (workbenchPage) => {
      const webview = await openCdsDebugWebview(workbenchPage);
      await expectSetupCredentialsScreen(webview);
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

      await webview.locator('#search-input').fill('mock-service-c');
      await expect(webview.locator('.app-name', { hasText: 'mock-service-c' })).toHaveCount(1);
      await expect(webview.locator('.app-name', { hasText: 'mock-service-a' })).toHaveCount(0);

      await webview.locator('#chk-select-all').uncheck();
      await expectButtonDisabled(startButton);
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
});
