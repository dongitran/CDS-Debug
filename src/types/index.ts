export const CF_DEFAULT_SPACE = 'app';

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
  | { type: 'RESET_LOGIN' };

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
  | { type: 'CONFIG_LOADED'; payload: { config: ExtensionConfig | null; groupFolders: string[]; activeSessions: Record<string, { status: string; message?: string }> } };
