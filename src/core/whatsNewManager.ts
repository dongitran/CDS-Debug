import type * as vscode from 'vscode';
import { WhatsNewPanel } from '../webview/whatsNewPanel';

const LAST_SHOWN_VERSION_KEY = 'cds-debug.lastShownWhatsNewVersion';

/** Returns true only for stable semver strings (no pre-release suffix). */
export function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function getCurrentVersion(context: vscode.ExtensionContext): string {
  const pkg = context.extension.packageJSON as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

export function shouldShowWhatsNew(context: vscode.ExtensionContext): boolean {
  const current = getCurrentVersion(context);
  if (!isStableVersion(current)) return false;

  const lastShown = context.globalState.get<string>(LAST_SHOWN_VERSION_KEY);
  return current !== lastShown;
}

export async function markWhatsNewShown(context: vscode.ExtensionContext): Promise<void> {
  const current = getCurrentVersion(context);
  await context.globalState.update(LAST_SHOWN_VERSION_KEY, current);
}

/**
 * Shows the What's New panel immediately if this is the first time the current
 * stable version has been activated. Call once per activation.
 */
export function showWhatsNewIfNeeded(context: vscode.ExtensionContext): void {
  if (!shouldShowWhatsNew(context)) return;

  // Defer slightly so the extension panel finishes loading first.
  setTimeout(() => {
    WhatsNewPanel.show(context);
    void markWhatsNewShown(context);
  }, 1500);
}
