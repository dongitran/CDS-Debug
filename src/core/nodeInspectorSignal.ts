import { getRemoteInspectorCleanupSettings } from './remoteInspectorSettings';

const LEGACY_SIGNAL_ALL_NODE_PROCESSES = 'kill -s USR1 $(pidof node)';

export function buildInspectorSignalCommand(): string {
  if (getRemoteInspectorCleanupSettings().signalAllNodeProcesses) return LEGACY_SIGNAL_ALL_NODE_PROCESSES;
  return [
    "MAIN_PID=$(ps -eo pid=,args= | grep -E 'node.*(server|app|index)\\.js' | grep -v grep | grep -v cds-mtxs | awk '{print $1}' | head -1);",
    'if [ -n "$MAIN_PID" ]; then echo CDS_DEBUG_SIGNAL_MODE=main; kill -s USR1 "$MAIN_PID";',
    'else FIRST_PID=$(pidof node | awk \'{print $1}\'); echo CDS_DEBUG_SIGNAL_MODE=fallback; [ -n "$FIRST_PID" ] && kill -s USR1 "$FIRST_PID"; fi',
  ].join(' ');
}
