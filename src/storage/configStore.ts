import type * as vscode from 'vscode';
import type { ExtensionConfig } from '../types/index';

const CONFIG_KEY = 'cds-debug.config';

let _context: vscode.ExtensionContext | undefined;

export function initConfigStore(context: vscode.ExtensionContext): void {
  _context = context;
}

function getContext(): vscode.ExtensionContext {
  if (_context === undefined) {
    throw new Error('ConfigStore not initialized. Call initConfigStore() first.');
  }
  return _context;
}

export function getConfig(): ExtensionConfig | undefined {
  return getContext().globalState.get<ExtensionConfig>(CONFIG_KEY);
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  await getContext().globalState.update(CONFIG_KEY, config);
}

export async function clearConfig(): Promise<void> {
  await getContext().globalState.update(CONFIG_KEY, undefined);
}
