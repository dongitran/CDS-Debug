import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test, type Page } from '@playwright/test';

export interface SessionDiagnostics {
  vscodeStdout: string[];
  vscodeStderr: string[];
  browserConsole: string[];
  pageErrors: string[];
  requestFailures: string[];
}

const DIAGNOSTIC_TAIL_SIZE = 120;
const STEP_CAPTURE_ENABLED = process.env.CDS_DEBUG_E2E_CAPTURE_STEPS === '1';

export function createSessionDiagnostics(): SessionDiagnostics {
  return {
    vscodeStdout: [],
    vscodeStderr: [],
    browserConsole: [],
    pageErrors: [],
    requestFailures: [],
  };
}

export function appendDiagnostic(target: string[], raw: string): void {
  const normalized = raw
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of normalized) {
    target.push(line);
  }
  if (target.length > DIAGNOSTIC_TAIL_SIZE) {
    target.splice(0, target.length - DIAGNOSTIC_TAIL_SIZE);
  }
}

function formatDiagnosticSection(label: string, lines: string[]): string {
  if (lines.length === 0) {
    return `${label}: <empty>`;
  }
  return `${label}:\n${lines.map((line) => `  ${line}`).join('\n')}`;
}

function formatErrorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDiagnosticsReport(error: unknown, diagnostics: SessionDiagnostics): string {
  return [
    `Original error: ${formatErrorSummary(error)}`,
    formatDiagnosticSection('VS Code stdout (tail)', diagnostics.vscodeStdout),
    formatDiagnosticSection('VS Code stderr (tail)', diagnostics.vscodeStderr),
    formatDiagnosticSection('Browser console (tail)', diagnostics.browserConsole),
    formatDiagnosticSection('Page errors (tail)', diagnostics.pageErrors),
    formatDiagnosticSection('Request failures (tail)', diagnostics.requestFailures),
  ].join('\n\n');
}

function sanitizeArtifactLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function writeArtifactFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function attachArtifact(name: string, path: string, contentType: string): Promise<void> {
  await test.info().attach(name, { path, contentType });
}

export function buildFailureError(error: unknown, diagnostics: SessionDiagnostics): Error {
  return new Error(`E2E failure with diagnostics\n\n${createDiagnosticsReport(error, diagnostics)}`);
}

export async function persistSessionArtifacts(options: {
  diagnostics: SessionDiagnostics;
  error?: unknown;
  label: string;
  page?: Page;
}): Promise<void> {
  const prefix = sanitizeArtifactLabel(options.label);
  const diagnosticsPath = test.info().outputPath(`${prefix}-diagnostics.txt`);
  const report = createDiagnosticsReport(options.error ?? 'Session completed without unhandled errors.', options.diagnostics);

  await writeArtifactFile(diagnosticsPath, report);
  await attachArtifact(`${prefix}-diagnostics`, diagnosticsPath, 'text/plain');

  if (!options.page) {
    return;
  }

  const screenshotPath = test.info().outputPath(`${prefix}-workbench.png`);
  try {
    await mkdir(dirname(screenshotPath), { recursive: true });
    await options.page.screenshot({ path: screenshotPath, fullPage: true });
    await attachArtifact(`${prefix}-workbench`, screenshotPath, 'image/png');
  } catch {
    // Workbench might already be closing; diagnostics are still preserved above.
  }

  try {
    const htmlPath = test.info().outputPath(`${prefix}-workbench.html`);
    await writeArtifactFile(htmlPath, await options.page.content());
    await attachArtifact(`${prefix}-workbench-html`, htmlPath, 'text/html');
  } catch {
    // HTML capture is best-effort only.
  }
}

export async function captureStepEvidence(page: Page, label: string): Promise<void> {
  if (!STEP_CAPTURE_ENABLED) {
    return;
  }

  const prefix = sanitizeArtifactLabel(`step-${label}`);
  const screenshotPath = test.info().outputPath(`${prefix}.png`);
  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await attachArtifact(prefix, screenshotPath, 'image/png');
}
