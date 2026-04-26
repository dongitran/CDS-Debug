import * as http from 'node:http';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { logInfo, logWarn } from './logger';

const INSPECTOR_METADATA_TIMEOUT_MS = 2_000;
const LINUX_CHROME_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'] as const;
const DEVTOOLS_FRONTEND_KEYS = ['devtoolsFrontendUrl', 'devtoolsFrontendUrlCompat'] as const;
const SAFE_DEVTOOLS_RAW_URL_PATTERN = /^[A-Za-z0-9:/?&=._~\-[\]]+$/;
const SAFE_DEVTOOLS_BUNDLED_PATH_PATTERN = /^\/bundled\/[A-Za-z0-9._~-]+\.html$/;
const SAFE_DEVTOOLS_QUERY_KEYS = new Set(['experiments', 'v8only', 'ws']);
const LOCAL_WS_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const CHROME_SPAWN_OPTIONS: SpawnOptions = {
  detached: true,
  shell: false,
  stdio: 'ignore',
  windowsHide: true,
};

export interface ChromeLaunchCommand {
  command: string;
  args: string[];
}

interface ChromeLaunchEnvironment {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function parseTargetIdFromUrl(rawUrl: string | undefined): string | null {
  if (rawUrl === undefined) return null;

  try {
    const parsed = new URL(rawUrl);
    const websocketPath = parsed.searchParams.get('ws');
    if (websocketPath !== null) {
      const websocketSegments = websocketPath.split('/').filter(Boolean);
      const websocketTargetId = websocketSegments[websocketSegments.length - 1];
      if (websocketTargetId !== undefined && websocketTargetId.length > 0) return websocketTargetId;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const targetId = segments[segments.length - 1];
    return targetId && targetId.length > 0 ? targetId : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isSafeLocalInspectorWsPath(pathname: string): boolean {
  const targetId = pathname.split('/').filter(Boolean).at(-1);
  return targetId !== undefined && /^[A-Za-z0-9._~-]+$/.test(targetId);
}

function isSafeLocalInspectorWsValue(value: string | null): boolean {
  if (value === null) return false;

  try {
    const wsUrl = new URL(`ws://${value}`);
    return LOCAL_WS_HOSTS.has(wsUrl.hostname)
      && wsUrl.port.length > 0
      && isSafeLocalInspectorWsPath(wsUrl.pathname);
  } catch {
    return false;
  }
}

function hasOnlySafeDevToolsQueryKeys(searchParams: URLSearchParams): boolean {
  for (const key of searchParams.keys()) {
    if (!SAFE_DEVTOOLS_QUERY_KEYS.has(key)) return false;
  }
  return true;
}

function isSafeDevToolsFrontendUrl(rawUrl: string): boolean {
  if (!SAFE_DEVTOOLS_RAW_URL_PATTERN.test(rawUrl)) return false;

  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'devtools:'
      && parsed.hostname === 'devtools'
      && SAFE_DEVTOOLS_BUNDLED_PATH_PATTERN.test(parsed.pathname)
      && hasOnlySafeDevToolsQueryKeys(parsed.searchParams)
      && isSafeLocalInspectorWsValue(parsed.searchParams.get('ws'));
  } catch {
    return false;
  }
}

function extractDevToolsFrontendUrlFromEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  for (const key of DEVTOOLS_FRONTEND_KEYS) {
    const frontendUrl = readString(record, key);
    if (frontendUrl !== undefined && isSafeDevToolsFrontendUrl(frontendUrl)) return frontendUrl;
  }
  return null;
}

function extractDevToolsFrontendUrl(metadata: unknown): string | null {
  if (!Array.isArray(metadata)) return null;

  for (const entry of metadata) {
    const frontendUrl = extractDevToolsFrontendUrlFromEntry(entry);
    if (frontendUrl !== null) return frontendUrl;
  }

  return null;
}

function extractTargetIdFromEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const explicitId = readString(record, 'id');
  if (explicitId !== undefined && explicitId.length > 0) return explicitId;

  return parseTargetIdFromUrl(readString(record, 'webSocketDebuggerUrl'))
    ?? parseTargetIdFromUrl(readString(record, 'devtoolsFrontendUrlCompat'))
    ?? parseTargetIdFromUrl(readString(record, 'devtoolsFrontendUrl'));
}

export function extractInspectorTargetId(metadata: unknown): string | null {
  if (!Array.isArray(metadata)) return null;

  for (const entry of metadata) {
    const targetId = extractTargetIdFromEntry(entry);
    if (targetId !== null) return targetId;
  }

  return null;
}

export function buildChromeDevToolsUrl(port: number, targetId: string): string {
  return `devtools://devtools/bundled/inspector.html?ws=localhost:${port.toString()}/${targetId}`;
}

function hasEnvValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function toChromeCommand(command: string, url: string): ChromeLaunchCommand {
  return { command, args: [url] };
}

function windowsChromePath(basePath: string): string {
  return `${basePath.replace(/[\\/]$/, '')}\\Google\\Chrome\\Application\\chrome.exe`;
}

function getCmdStartChromeCommand(command: string, url: string): ChromeLaunchCommand | null {
  if (!isSafeDevToolsFrontendUrl(url)) return null;
  return { command, args: ['/d', '/s', '/c', `start "" chrome "${url}"`] };
}

function getWindowsChromeCommands(url: string, env: NodeJS.ProcessEnv): ChromeLaunchCommand[] {
  const commands = ['chrome.exe'];
  const localAppData = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles;
  const programFilesX86 = env['ProgramFiles(x86)'];

  if (hasEnvValue(localAppData)) commands.push(windowsChromePath(localAppData));
  if (hasEnvValue(programFiles)) commands.push(windowsChromePath(programFiles));
  if (hasEnvValue(programFilesX86)) commands.push(windowsChromePath(programFilesX86));

  const launchCommands = commands.map((command) => toChromeCommand(command, url));
  const cmdStart = getCmdStartChromeCommand('cmd.exe', url);
  return cmdStart === null ? launchCommands : [...launchCommands, cmdStart];
}

function getMacChromeCommands(url: string): ChromeLaunchCommand[] {
  return [{ command: 'open', args: ['-a', 'Google Chrome', url] }];
}

function isWslEnvironment(env: NodeJS.ProcessEnv): boolean {
  return hasEnvValue(env.WSL_DISTRO_NAME) || hasEnvValue(env.WSL_INTEROP);
}

function getWslWindowsChromeCommands(url: string): ChromeLaunchCommand[] {
  const commands = [
    toChromeCommand('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', url),
    toChromeCommand('/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe', url),
  ];

  const directCmdStart = getCmdStartChromeCommand('/mnt/c/Windows/System32/cmd.exe', url);
  const pathCmdStart = getCmdStartChromeCommand('cmd.exe', url);
  if (directCmdStart !== null && pathCmdStart !== null) return [...commands, directCmdStart, pathCmdStart];

  return commands;
}

function getLinuxChromeCommands(url: string, env: NodeJS.ProcessEnv): ChromeLaunchCommand[] {
  const commands = LINUX_CHROME_COMMANDS.map((command) => toChromeCommand(command, url));
  return isWslEnvironment(env) ? [...getWslWindowsChromeCommands(url), ...commands] : commands;
}

export function getChromeLaunchCommands(
  url: string,
  environment: Partial<ChromeLaunchEnvironment> = {},
): ChromeLaunchCommand[] {
  const env = environment.env ?? process.env;
  const platform = environment.platform ?? process.platform;

  if (platform === 'win32') return getWindowsChromeCommands(url, env);
  if (platform === 'darwin') return getMacChromeCommands(url);
  if (platform === 'linux') return getLinuxChromeCommands(url, env);
  return [];
}

function trySpawnChromeCommand(candidate: ChromeLaunchCommand): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(candidate.command, candidate.args, CHROME_SPAWN_OPTIONS);
    } catch {
      resolve(false);
      return;
    }

    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.once('error', () => {
      resolve(false);
    });
  });
}

export async function launchChromeDevToolsUrl(
  url: string,
  commands = getChromeLaunchCommands(url),
): Promise<boolean> {
  for (const candidate of commands) {
    if (await trySpawnChromeCommand(candidate)) return true;
  }
  return false;
}

async function fetchInspectorBody(port: number, path: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = http.get(
      {
        host: '127.0.0.1',
        path,
        port,
        timeout: INSPECTOR_METADATA_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== undefined && res.statusCode >= 400) {
          res.resume();
          finish(null);
          return;
        }

        res.setEncoding('utf8');
        let raw = '';
        res.on('data', (chunk: string) => {
          raw += chunk;
        });
        res.on('end', () => {
          finish(raw);
        });
      },
    );

    req.on('error', () => {
      finish(null);
    });
    req.setTimeout(INSPECTOR_METADATA_TIMEOUT_MS, () => {
      req.destroy();
      finish(null);
    });
  });
}

async function fetchInspectorMetadata(port: number, path: string): Promise<unknown> {
  const body = await fetchInspectorBody(port, path);
  if (body === null) return null;

  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return null;
  }
}

export async function resolveChromeDevToolsUrl(port: number): Promise<string | null> {
  const listMetadata = await fetchInspectorMetadata(port, '/json/list');
  const listFrontendUrl = extractDevToolsFrontendUrl(listMetadata);
  if (listFrontendUrl !== null) return listFrontendUrl;

  const listTargetId = extractInspectorTargetId(listMetadata);
  if (listTargetId !== null) return buildChromeDevToolsUrl(port, listTargetId);

  const metadata = await fetchInspectorMetadata(port, '/json');
  const frontendUrl = extractDevToolsFrontendUrl(metadata);
  if (frontendUrl !== null) return frontendUrl;

  const targetId = extractInspectorTargetId(metadata);
  return targetId === null ? null : buildChromeDevToolsUrl(port, targetId);
}

export async function openChromeDevTools(port: number, appName: string): Promise<boolean> {
  const url = await resolveChromeDevToolsUrl(port);
  if (url === null) {
    logWarn(`[${appName}] Could not resolve Node inspector target id; skipping Chrome DevTools auto-open.`);
    return false;
  }

  logInfo(`[${appName}] Opening Chrome DevTools at ${url}`);
  const commands = getChromeLaunchCommands(url);
  const opened = await launchChromeDevToolsUrl(url, commands);
  if (!opened) {
    logWarn(`[${appName}] Could not launch Chrome DevTools. Tried: ${commands.map((command) => command.command).join(', ')}`);
  }
  return opened;
}
