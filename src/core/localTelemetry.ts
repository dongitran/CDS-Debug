import type * as vscode from 'vscode';
import { logWarn } from './logger';

export type LocalTelemetryCounter =
  | 'remoteInspectorReminderShown'
  | 'remoteInspectorRestartClicked'
  | 'debuggerLiteralWarningShown'
  | 'orphanTunnelReaped'
  | 'keepaliveReconnectTriggered';

const LOCAL_TELEMETRY_KEY = 'cds-debug.localTelemetryCounters';

let telemetryContext: vscode.ExtensionContext | undefined;

export function initializeLocalTelemetry(context: vscode.ExtensionContext): void {
  telemetryContext = context;
}

export function readLocalTelemetryCounters(): Partial<Record<LocalTelemetryCounter, number>> {
  return readCounters();
}

export async function incrementLocalTelemetryCounter(counter: LocalTelemetryCounter): Promise<void> {
  if (telemetryContext === undefined) return;
  const counters = readCounters();
  counters[counter] = (counters[counter] ?? 0) + 1;
  try {
    await telemetryContext.globalState.update(LOCAL_TELEMETRY_KEY, counters);
  } catch (err: unknown) {
    logWarn(`[LocalTelemetry] Failed to update ${counter}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readCounters(): Partial<Record<LocalTelemetryCounter, number>> {
  if (telemetryContext === undefined) return {};
  const stored = telemetryContext.globalState.get<unknown>(LOCAL_TELEMETRY_KEY);
  if (typeof stored !== 'object' || stored === null) return {};
  const record = stored as Record<string, unknown>;
  const counters: Partial<Record<LocalTelemetryCounter, number>> = {};
  for (const counter of knownCounters()) {
    if (typeof record[counter] === 'number') counters[counter] = record[counter];
  }
  return counters;
}

function knownCounters(): LocalTelemetryCounter[] {
  return [
    'remoteInspectorReminderShown',
    'remoteInspectorRestartClicked',
    'debuggerLiteralWarningShown',
    'orphanTunnelReaped',
    'keepaliveReconnectTriggered',
  ];
}
