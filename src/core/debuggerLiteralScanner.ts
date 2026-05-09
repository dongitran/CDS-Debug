import { opendir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { extname, join } from 'node:path';

export interface DebuggerLiteralMatch {
  filePath: string;
  line: number;
  preview: string;
}

export interface DebuggerLiteralScanOptions {
  maxDepth?: number;
  maxFilesScanned?: number;
}

interface NormalizedScanOptions {
  maxDepth: number;
  maxFilesScanned: number;
}

interface ScanState {
  filesScanned: number;
  matches: DebuggerLiteralMatch[];
  options: NormalizedScanOptions;
}

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const MAX_MATCHES = 20;

export async function scanForDebuggerLiterals(
  localRoot: string,
  options: DebuggerLiteralScanOptions = {},
): Promise<DebuggerLiteralMatch[]> {
  const rootExists = await isDirectory(localRoot);
  if (!rootExists) return [];

  const state: ScanState = {
    filesScanned: 0,
    matches: [],
    options: normalizeOptions(options),
  };

  await scanDirectory(localRoot, 0, state);
  return state.matches
    .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line)
    .slice(0, MAX_MATCHES);
}

function normalizeOptions(options: DebuggerLiteralScanOptions): NormalizedScanOptions {
  return {
    maxDepth: Math.max(0, options.maxDepth ?? 8),
    maxFilesScanned: Math.max(0, options.maxFilesScanned ?? 2000),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function scanDirectory(dirPath: string, depth: number, state: ScanState): Promise<void> {
  if (depth > state.options.maxDepth || state.filesScanned >= state.options.maxFilesScanned) return;

  let entries: Awaited<ReturnType<typeof readDirectoryEntries>>;
  try {
    entries = await readDirectoryEntries(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.filesScanned >= state.options.maxFilesScanned) return;
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await scanDirectory(entryPath, depth + 1, state);
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) continue;
    state.filesScanned += 1;
    await scanFile(entryPath, state);
  }
}

async function readDirectoryEntries(dirPath: string): Promise<Dirent[]> {
  const dir = await opendir(dirPath);
  const entries: Dirent[] = [];
  for await (const entry of dir) {
    entries.push(entry);
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function isSourceFile(fileName: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(fileName));
}

async function scanFile(filePath: string, state: ScanState): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return;
  }

  let inBlockComment = false;
  const lines = content.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const stripped = stripBlockComments(rawLine, inBlockComment);
    inBlockComment = stripped.inBlockComment;
    if (!hasDebuggerStatement(stripped.code)) continue;
    state.matches.push({
      filePath,
      line: index + 1,
      preview: rawLine.trim(),
    });
    if (state.matches.length >= MAX_MATCHES) return;
  }
}

function stripBlockComments(line: string, initialInBlockComment: boolean): { code: string; inBlockComment: boolean } {
  let rest = line;
  let code = '';
  let inBlockComment = initialInBlockComment;

  while (rest.length > 0) {
    if (inBlockComment) {
      const end = rest.indexOf('*/');
      if (end === -1) return { code, inBlockComment: true };
      rest = rest.slice(end + 2);
      inBlockComment = false;
      continue;
    }

    const start = rest.indexOf('/*');
    if (start === -1) {
      code += rest;
      break;
    }
    code += rest.slice(0, start);
    rest = rest.slice(start + 2);
    inBlockComment = true;
  }

  return { code, inBlockComment };
}

function hasDebuggerStatement(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//')) return false;
  const codeBeforeLineComment = line.split('//', 1)[0] ?? '';
  return /^\s*debugger\s*;\s*$/.test(codeBeforeLineComment);
}
