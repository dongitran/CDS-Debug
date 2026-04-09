export const CF_DEFAULT_SPACE = 'app';

export interface CredentialStatus {
  hasCredentials: boolean;
  maskedEmail: string;
  /** 'env' = process.env or login-shell, 'keychain' = VS Code SecretStorage, 'none' = not set */
  source: 'env' | 'keychain' | 'none';
}

// Schema for the optional per-project config file (cap-debug-config.json).
export interface CapDebugConfig {
  remoteRoot?: string;
  /** Per-service branch override — takes priority over orgBranchMap. */
  branch?: string;
  /** Maps CF org name to the git branch that should be checked out before debugging. */
  orgBranchMap?: Record<string, string>;
}

export type BranchPrepStep =
  | 'pending'
  | 'stashing'
  | 'checking-out'
  | 'pulling'
  | 'installing'
  | 'building'
  | 'done'
  | 'skipped'
  | 'error';

export interface BranchPrepService {
  appName: string;
  targetBranch: string;
  currentBranch: string;
}

export const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export const DEBUG_BASE_PORT = 20000;

export type CfAppState = 'started' | 'stopped' | 'empty';

export interface CfApp {
  name: string;
  state: CfAppState;
  urls?: string[];
}

export interface OrgGroupMapping {
  cfOrg: string;
  groupFolderPath: string; // absolute path to the local group folder
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
  address: string;
  port: number;
  localRoot: string;
  remoteRoot?: string;
  sourceMaps: boolean;
  restart: boolean;
  skipFiles: string[];
  outFiles: string[];
}

export interface LaunchJson {
  version: string;
  configurations: LaunchConfiguration[];
}

export interface ExtensionConfig {
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
  intervalHours: 24,
};

/** User-facing debug behavior preferences (separate from cache settings). */
export interface DebugPreferences {
  /**
   * When true, the app URL is opened in the default browser automatically
   * as soon as a debug session reaches the ATTACHED state. Default: false.
   */
  openBrowserOnAttach: boolean;
  /**
   * When true, the branch auto-checkout feature is enabled: before starting
   * a debug session the extension stashes local changes, checks out the mapped
   * branch, then runs `pnpm i --shamefully-hoist` and `pnpm build`.
   * This is an experimental / potentially destructive operation. Default: false.
   */
  enableBranchPrep: boolean;
}

export const DEFAULT_DEBUG_PREFERENCES: DebugPreferences = {
  openBrowserOnAttach: false,
  enableBranchPrep: false,
};

// Messages from webview → extension
export type WebviewMessage =
  | { type: 'SELECT_GROUP_FOLDER' }
  | { type: 'LOGIN'; payload: { apiEndpoint: string } }
  | { type: 'LOAD_APPS'; payload: { org: string } }
  | { type: 'START_DEBUG'; payload: { appNames: string[]; org: string } }
  | { type: 'STOP_DEBUG'; payload: { appName: string } }
  | { type: 'STOP_ALL_DEBUG' }
  | { type: 'OPEN_APP_URL'; payload: { url: string; source: 'manual' | 'auto' } }
  | { type: 'SAVE_MAPPINGS'; payload: { mappings: OrgGroupMapping[] } }
  | { type: 'LOAD_CONFIG' }
  | { type: 'RESET_LOGIN' }
  | { type: 'TRIGGER_SYNC' }
  | { type: 'GET_SYNC_STATUS' }
  | { type: 'GET_CACHE_CONFIG' }
  | { type: 'SAVE_CACHE_CONFIG'; payload: CacheSettings }
  | { type: 'GET_DEBUG_PREFS' }
  | { type: 'SAVE_DEBUG_PREFS'; payload: DebugPreferences }
  | { type: 'REQUEST_CHANGE_MAPPING' }
  | { type: 'SAVE_CREDENTIALS'; payload: { email: string; password: string } }
  | { type: 'GET_CREDENTIALS_STATUS' }
  | { type: 'CLEAR_CREDENTIALS' };

// Messages from extension → webview
export type ExtensionMessage =
  | { type: 'GROUP_FOLDER_SELECTED'; payload: { path: string } }
  | { type: 'LOGIN_SUCCESS'; payload: { orgs: string[] } }
  | { type: 'LOGIN_ERROR'; payload: { message: string } }
  | { type: 'APPS_LOADED'; payload: { apps: CfApp[] } }
  | { type: 'APPS_ERROR'; payload: { message: string } }
  | { type: 'DEBUG_STARTED'; payload: { count: number } }
  | { type: 'DEBUG_CONNECTING'; payload: { appNames: string[]; ports: Record<string, number> } }
  | { type: 'APP_DEBUG_STATUS'; payload: { appName: string; status: string; message?: string } }
  | { type: 'DEBUG_ERROR'; payload: { message: string } }
  | { type: 'CONFIG_LOADED'; payload: { config: ExtensionConfig | null; activeSessions: Record<string, { status: string; message?: string }>; credentialStatus: CredentialStatus } }
  | { type: 'SYNC_STATUS'; payload: SyncProgress }
  | { type: 'CACHE_CONFIG'; payload: CacheSettings }
  | { type: 'DEBUG_PREFS'; payload: DebugPreferences }
  | { type: 'BRANCH_PREP_START'; payload: { services: { appName: string; currentBranch: string; targetBranch: string }[] } }
  | { type: 'BRANCH_PREP_STATUS'; payload: { appName: string; step: BranchPrepStep; message?: string } }
  | { type: 'PROCEED_CHANGE_MAPPING' }
  | { type: 'CREDENTIALS_SAVED'; payload: { maskedEmail: string; source: 'env' | 'keychain' | 'none' } }
  | { type: 'CREDENTIALS_ERROR'; payload: { message: string } }
  | { type: 'CREDENTIALS_STATUS'; payload: CredentialStatus }
  | { type: 'CREDENTIALS_REVOKED'; payload: { message: string } };
