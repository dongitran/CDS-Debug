export const CF_DEFAULT_SPACE = 'app';

export const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export const DEBUG_BASE_PORT = 9229;

export type CfAppState = 'started' | 'stopped';

export interface CfApp {
  name: string;
  state: CfAppState;
  urls?: string[];
}

export interface OrgGroupMapping {
  cfOrg: string;
  localGroupPath: string;
}

export interface DebugTarget {
  appName: string;
  folderPath: string;
  port: number;
}

export interface LaunchConfiguration {
  type: string;
  request: string;
  name: string;
  port: number;
  localRoot: string;
  remoteRoot: string;
  sourceMaps: boolean;
  restart: boolean;
  skipFiles: string[];
}

export interface LaunchJson {
  version: string;
  configurations: LaunchConfiguration[];
}

export interface ExtensionConfig {
  rootFolderPath: string;
  apiEndpoint: string;
  orgs: string[];
  orgGroupMappings: OrgGroupMapping[];
}

export interface CfOrgCache {
  apps: CfApp[];
  cachedAt: number;
}

export interface CfRegionCache {
  apiEndpoint: string;
  orgs: string[];
  appsByOrg: Record<string, CfOrgCache>;
  lastSyncedAt: number;
}

export interface SyncProgress {
  isRunning: boolean;
  startedAt?: number;
  lastCompletedAt?: number;
  // Explicitly allow undefined so spread resets like `{ ...p, currentOrg: undefined }`
  // are valid under exactOptionalPropertyTypes: true.
  currentRegion?: string | undefined;
  currentOrg?: string | undefined;
  done: number;
  total: number;
}

export interface CacheSettings {
  enabled: boolean;
  intervalHours: number;
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  enabled: true,
  intervalHours: 4,
};

// Messages from webview → extension
export type WebviewMessage =
  | { type: 'SELECT_ROOT_FOLDER' }
  | { type: 'LOGIN'; payload: { apiEndpoint: string } }
  | { type: 'LOAD_APPS'; payload: { org: string } }
  | { type: 'START_DEBUG'; payload: { appNames: string[]; org: string } }
  | { type: 'STOP_DEBUG'; payload: { appName: string } }
  | { type: 'OPEN_APP_URL'; payload: { url: string } }
  | { type: 'SAVE_MAPPINGS'; payload: { mappings: OrgGroupMapping[] } }
  | { type: 'LOAD_CONFIG' }
  | { type: 'RESET_LOGIN' }
  | { type: 'TRIGGER_SYNC' }
  | { type: 'GET_SYNC_STATUS' }
  | { type: 'GET_CACHE_CONFIG' }
  | { type: 'SAVE_CACHE_CONFIG'; payload: CacheSettings };

// Messages from extension → webview
export type ExtensionMessage =
  | { type: 'ROOT_FOLDER_SELECTED'; payload: { path: string; groupFolders: string[] } }
  | { type: 'LOGIN_SUCCESS'; payload: { orgs: string[] } }
  | { type: 'LOGIN_ERROR'; payload: { message: string } }
  | { type: 'APPS_LOADED'; payload: { apps: CfApp[] } }
  | { type: 'APPS_ERROR'; payload: { message: string } }
  | { type: 'DEBUG_STARTED'; payload: { count: number } }
  | { type: 'DEBUG_CONNECTING'; payload: { appNames: string[] } }
  | { type: 'APP_DEBUG_STATUS'; payload: { appName: string; status: string; message?: string } }
  | { type: 'DEBUG_ERROR'; payload: { message: string } }
  | { type: 'CONFIG_LOADED'; payload: { config: ExtensionConfig | null; groupFolders: string[]; activeSessions: Record<string, { status: string; message?: string }> } }
  | { type: 'SYNC_STATUS'; payload: SyncProgress }
  | { type: 'CACHE_CONFIG'; payload: CacheSettings };
