import * as http from 'node:http';
import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';

const INSPECTOR_METADATA_TIMEOUT_MS = 2_000;

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
  const listTargetId = extractInspectorTargetId(listMetadata);
  if (listTargetId !== null) return buildChromeDevToolsUrl(port, listTargetId);

  const metadata = await fetchInspectorMetadata(port, '/json');
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
  await vscode.env.openExternal(vscode.Uri.parse(url, true));
  return true;
}
