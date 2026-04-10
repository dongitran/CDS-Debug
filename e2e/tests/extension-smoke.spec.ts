import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect, test, type Browser, type BrowserContext, type Frame, type Page } from '@playwright/test';

const MOCK_CF_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

cmd="\${1:-}"

case "$cmd" in
  api)
    echo "Setting API endpoint to \${2:-}..."
    echo "OK"
    ;;
  auth)
    echo "Authenticating..."
    echo "OK"
    ;;
  logout)
    echo "OK"
    ;;
  orgs)
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
    cat <<'OUT'
name   requested state   processes   routes
mock-service-a   started   1/1   mock-service-a.cfapps.example.com
mock-service-b   stopped   0/1   mock-service-b.cfapps.example.com
OUT
    ;;
  ssh-enabled)
    echo "ssh support is enabled for app \${2:-}"
    ;;
  enable-ssh|restart)
    echo "OK"
    ;;
  *)
    echo "mock cf: unsupported command: $cmd" >&2
    exit 1
    ;;
esac
`;

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

async function createMockCfCli(mockBinDir: string): Promise<void> {
  const cfPath = join(mockBinDir, 'cf');
  await writeFile(cfPath, MOCK_CF_SCRIPT, 'utf8');
  await chmod(cfPath, 0o755);
}

function buildVsCodeEnv(mockBinDir: string): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH ?? '';

  return {
    ...process.env,
    SAP_EMAIL: 'e2e.mock.user@example.com',
    SAP_PASSWORD: 'e2e-mock-password',
    SHELL: '/usr/bin/false',
    PATH: `${mockBinDir}${delimiter}${inheritedPath}`,
  };
}

function launchVsCode(
  repoRoot: string,
  workspacePath: string,
  userDataDir: string,
  extensionsDir: string,
  cdpPort: number,
  mockBinDir: string,
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
    workspacePath,
  ];

  return spawn('code', args, {
    cwd: repoRoot,
    env: buildVsCodeEnv(mockBinDir),
    stdio: 'pipe',
  });
}

async function waitForCdpEndpoint(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port.toString()}/json/version`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // CDP endpoint is not ready yet.
    }
    await delay(250);
  }

  throw new Error(`CDP endpoint did not become ready on port ${port.toString()}.`);
}

async function waitForWorkbenchPage(context: BrowserContext): Promise<Page> {
  const deadline = Date.now() + 90_000;

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

async function openExtensionView(page: Page): Promise<void> {
  const activityBarItem = page
    .locator('[id="workbench.parts.activitybar"] [aria-label="CDS Debug"]')
    .first();

  await expect(activityBarItem).toBeVisible({ timeout: 90_000 });
  await activityBarItem.click();
}

async function waitForExtensionWebviewFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 90_000;
  const markers = ['CF Region', 'Login to Cloud Foundry', 'Setup Credentials'];

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const url = frame.url();
      if (url.includes('workbench.html')) {
        continue;
      }

      try {
        const text = await frame.locator('body').innerText();
        if (markers.some((marker) => text.includes(marker))) {
          return frame;
        }
      } catch {
        // Frame may still be initializing.
      }
    }
    await delay(250);
  }

  throw new Error('Could not find CDS Debug webview frame.');
}

async function terminateProcess(
  process: ChildProcessWithoutNullStreams,
  browser?: Browser,
  page?: Page,
): Promise<void> {
  if (process.exitCode !== null) return;

  if (browser) {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close');
    } catch {
      // Fall back to keyboard/signal shutdown below.
    }
  }

  if (process.exitCode !== null) return;

  if (page) {
    try {
      await page.bringToFront();
      await page.locator('body').click();
      await page.keyboard.press('Meta+Shift+W');
    } catch {
      // Fall back to signal-based shutdown below.
    }
  }

  const exited = await Promise.race([
    once(process, 'exit').then(() => true),
    delay(10_000).then(() => false),
  ]);

  if (!exited && process.exitCode === null) {
    process.kill('SIGTERM');
    const exitedAfterSigterm = await Promise.race([
      once(process, 'exit').then(() => true),
      delay(5_000).then(() => false),
    ]);
    if (exitedAfterSigterm || process.exitCode !== null) return;

    process.kill('SIGKILL');
    await once(process, 'exit');
  }
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

async function assertMockLoginFlow(workbenchPage: Page): Promise<void> {
  await openExtensionView(workbenchPage);
  await expect(workbenchPage.locator('iframe.webview').first()).toBeVisible({ timeout: 90_000 });

  const webview = await waitForExtensionWebviewFrame(workbenchPage);
  await expect(webview.getByText('CF Region')).toBeVisible();
  await expect(webview.getByText('Select Region')).toBeVisible();
  await expect(webview.getByRole('button', { name: 'Login to Cloud Foundry' })).toBeVisible();

  await webview.getByRole('button', { name: 'Login to Cloud Foundry' }).click();
  await expect(webview.getByText('Select CF Org')).toBeVisible();
  await expect(webview.getByText('mock-org-alpha')).toBeVisible();
}

test('User can open CDS Debug panel and see CF region login screen', async () => {
  const repoRoot = resolve(process.cwd(), '..');
  const workspacePath = repoRoot;
  const cdpPort = await allocatePort();
  const userDataDir = await createTempDirectory('cds-debug-e2e-user-');
  const extensionsDir = await createTempDirectory('cds-debug-e2e-extensions-');
  const mockBinDir = await createTempDirectory('cds-debug-e2e-bin-');
  await createMockCfCli(mockBinDir);

  let appProcess: ChildProcessWithoutNullStreams | undefined;
  let browser: Browser | undefined;
  let workbenchPage: Page | undefined;

  try {
    appProcess = launchVsCode(
      repoRoot,
      workspacePath,
      userDataDir,
      extensionsDir,
      cdpPort,
      mockBinDir,
    );

    await waitForCdpEndpoint(cdpPort, 90_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort.toString()}`);

    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('No browser context was created for VS Code.');
    }

    workbenchPage = await waitForWorkbenchPage(context);
    await workbenchPage.bringToFront();
    await assertMockLoginFlow(workbenchPage);
  } finally {
    if (appProcess) {
      await terminateProcess(appProcess, browser, workbenchPage);
    }

    if (browser) {
      await browser.close().catch(() => undefined);
    }

    await removeDirWithRetry(userDataDir);
    await removeDirWithRetry(extensionsDir);
    await removeDirWithRetry(mockBinDir);
  }
});
