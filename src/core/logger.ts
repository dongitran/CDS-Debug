import * as vscode from 'vscode';

const CHANNEL_NAME = 'CDS Debug';

let _channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  _channel ??= vscode.window.createOutputChannel(CHANNEL_NAME);
  return _channel;
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function logInfo(message: string): void {
  getChannel().appendLine(`[${timestamp()}] [INFO]  ${message}`);
}

export function logError(message: string): void {
  const ch = getChannel();
  ch.appendLine(`[${timestamp()}] [ERROR] ${message}`);
  ch.show(true);
}

export function logWarn(message: string): void {
  getChannel().appendLine(`[${timestamp()}] [WARN]  ${message}`);
}

export function disposeLogger(): void {
  _channel?.dispose();
  _channel = undefined;
}
