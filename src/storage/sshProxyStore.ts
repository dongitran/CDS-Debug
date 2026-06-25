import type { SaveSshProxySettingsPayload, SshProxyPublicSettings } from '../types/index';

const SETTINGS_KEY = 'cds-debug.sshProxy.settings';
const PASSWORD_KEY = 'cds-debug.sshProxy.password';
const DEFAULT_SSH_PORT = 22;

interface GlobalStateLike {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface SshProxyStoreContext {
  globalState: GlobalStateLike;
  secrets: SecretStorageLike;
}

interface StoredSshProxySettings {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  trustedHostFingerprint?: string;
}

export interface SshProxyConnectionConfig extends StoredSshProxySettings {
  password?: string;
}

let context: SshProxyStoreContext | undefined;

export function initSshProxyStore(nextContext: SshProxyStoreContext | undefined): void {
  context = nextContext;
}

function requireContext(): SshProxyStoreContext {
  if (context === undefined) {
    throw new Error('SSH proxy store is not initialized.');
  }
  return context;
}

function readStoredSettings(): StoredSshProxySettings {
  const stored = requireContext().globalState.get(SETTINGS_KEY);
  if (typeof stored !== 'object' || stored === null) return defaultSettings();
  const value = stored as Record<string, unknown>;
  const port = value.port;
  const settings: StoredSshProxySettings = {
    enabled: value.enabled === true,
    host: typeof value.host === 'string' ? value.host : '',
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : DEFAULT_SSH_PORT,
    username: typeof value.username === 'string' ? value.username : '',
  };
  if (typeof value.trustedHostFingerprint === 'string' && value.trustedHostFingerprint.length > 0) {
    settings.trustedHostFingerprint = value.trustedHostFingerprint;
  }
  return settings;
}

function defaultSettings(): StoredSshProxySettings {
  return {
    enabled: false,
    host: '',
    port: DEFAULT_SSH_PORT,
    username: '',
  };
}

export async function getSshProxyPublicSettings(): Promise<SshProxyPublicSettings> {
  const settings = readStoredSettings();
  const password = await requireContext().secrets.get(PASSWORD_KEY);
  return {
    enabled: settings.enabled,
    host: settings.host,
    port: settings.port,
    username: settings.username,
    hasPassword: typeof password === 'string' && password.length > 0,
  };
}

export async function getSshProxyConnectionConfig(): Promise<SshProxyConnectionConfig> {
  const settings = readStoredSettings();
  const password = await requireContext().secrets.get(PASSWORD_KEY);
  return password === undefined ? settings : { ...settings, password };
}

export async function saveSshProxySettings(payload: SaveSshProxySettingsPayload): Promise<void> {
  const previous = readStoredSettings();
  const endpointChanged = previous.host !== payload.host || previous.port !== payload.port;
  const next: StoredSshProxySettings = {
    enabled: payload.enabled,
    host: payload.host,
    port: payload.port,
    username: payload.username,
  };
  if (!endpointChanged && previous.trustedHostFingerprint !== undefined) {
    next.trustedHostFingerprint = previous.trustedHostFingerprint;
  }

  const store = requireContext();
  if (payload.password !== undefined && payload.password.length > 0) {
    await store.secrets.store(PASSWORD_KEY, payload.password);
  }
  await store.globalState.update(SETTINGS_KEY, next);
}

export async function saveTrustedSshHostFingerprint(fingerprint: string): Promise<void> {
  const settings = readStoredSettings();
  await requireContext().globalState.update(SETTINGS_KEY, {
    ...settings,
    trustedHostFingerprint: fingerprint,
  });
}

export async function clearSshProxySettings(): Promise<void> {
  const store = requireContext();
  await store.globalState.update(SETTINGS_KEY, undefined);
  await store.secrets.delete(PASSWORD_KEY);
}
