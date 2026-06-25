import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer as createNetServer, type Server } from 'node:net';
import type { Duplex } from 'node:stream';
import { createServer } from '@pondwader/socks5-server';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { SshProxyStatus } from '../types/index';
import {
  getSshProxyConnectionConfig,
  getSshProxyPublicSettings,
  saveTrustedSshHostFingerprint,
  type SshProxyConnectionConfig,
} from '../storage/sshProxyStore';
import { logInfo, logWarn } from './logger';

export interface LocalSocksProxy {
  host: '127.0.0.1';
  port: number;
}

interface HostKeyObservation {
  fingerprint?: string;
  mismatch: boolean;
}

export const sshProxyEvents = new EventEmitter();

let status: SshProxyStatus = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  hasPassword: false,
  connection: 'disabled',
};
let sshClient: Client | undefined;
let socksServer: Server | undefined;
let activeProxy: LocalSocksProxy | undefined;
let activeIdentity: string | undefined;
let connecting: Promise<LocalSocksProxy | undefined> | undefined;
let cancelPendingConnection: (() => void) | undefined;
let lifecycleVersion = 0;
const activeStreams = new Set<Duplex>();

export function getSshProxyStatus(): SshProxyStatus {
  return { ...status };
}

function updateStatus(next: SshProxyStatus): void {
  status = next;
  sshProxyEvents.emit('statusChanged', getSshProxyStatus());
}

function connectionIdentity(config: SshProxyConnectionConfig): string {
  return JSON.stringify([config.host, config.port, config.username]);
}

function fingerprintHostKey(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function sanitizeError(error: unknown, password?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (password === undefined || password.length === 0) return raw;
  return raw.split(password).join('[redacted]');
}

async function buildBaseStatus(connection: SshProxyStatus['connection']): Promise<SshProxyStatus> {
  const settings = await getSshProxyPublicSettings();
  return { ...settings, connection };
}

export async function ensureSshProxy(): Promise<LocalSocksProxy | undefined> {
  const config = await getSshProxyConnectionConfig();
  if (!config.enabled) {
    updateStatus(await buildBaseStatus('disabled'));
    return undefined;
  }
  if (!config.password) {
    const message = 'SSH proxy password is not configured.';
    updateStatus({ ...await buildBaseStatus('error'), message });
    throw new Error(message);
  }

  const identity = connectionIdentity(config);
  if (activeProxy !== undefined && activeIdentity === identity) return activeProxy;
  if (connecting !== undefined) return connecting;
  const version = ++lifecycleVersion;
  const tracked = connectSshProxy(config, version).finally(() => {
    if (connecting === tracked) connecting = undefined;
  });
  connecting = tracked;
  return tracked;
}

async function connectSshProxy(
  config: SshProxyConnectionConfig,
  version: number,
): Promise<LocalSocksProxy> {
  await closeRuntime();
  if (version !== lifecycleVersion) throw new Error('SSH proxy connection was canceled.');
  updateStatus(await buildBaseStatus('connecting'));
  if (process.env.CDS_DEBUG_E2E_MODE === '1' && process.env.CDS_DEBUG_E2E_SSH_PROXY_RESULT === 'success') {
    const proxy = { host: '127.0.0.1', port: 49152 } as const;
    activeProxy = proxy;
    activeIdentity = connectionIdentity(config);
    updateStatus({ ...await buildBaseStatus('connected'), localPort: proxy.port });
    return proxy;
  }
  return openSshConnection(config, version);
}

async function openSshConnection(
  config: SshProxyConnectionConfig,
  version: number,
): Promise<LocalSocksProxy> {
  const client = new Client();
  sshClient = client;
  const observation: HostKeyObservation = { mismatch: false };
  const ready = waitForSshReady(client, config, observation, version);
  client.connect(buildConnectConfig(config, (fingerprint, matches) => {
    observation.fingerprint = fingerprint;
    observation.mismatch = !matches;
  }));
  return ready;
}

function waitForSshReady(
  client: Client,
  config: SshProxyConnectionConfig,
  observation: HostKeyObservation,
  version: number,
): Promise<LocalSocksProxy> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      client.removeListener('error', fail);
      client.removeListener('ready', ready);
      if (cancelPendingConnection === cancel) cancelPendingConnection = undefined;
    };
    const rejectOnce = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const fail = (error: unknown): void => {
      if (sshClient !== client) return;
      const message = observation.mismatch
        ? 'SSH host key changed. Clear the proxy configuration and verify the home computer before reconnecting.'
        : sanitizeError(error, config.password);
      rejectOnce(message);
      void handleConnectionFailure(client, message);
    };
    const cancel = (): void => {
      rejectOnce('SSH proxy connection was canceled.');
    };
    const ready = (): void => {
      void finishConnection(client, config, observation.fingerprint, version).then((proxy) => {
        if (settled) return;
        settled = true;
        cleanup();
        bindConnectedClientLifecycle(client);
        resolve(proxy);
      }, fail);
    };
    cancelPendingConnection = cancel;
    client.once('error', fail);
    client.once('ready', ready);
  });
}

function buildConnectConfig(
  config: SshProxyConnectionConfig,
  onFingerprint: (fingerprint: string, matches: boolean) => void,
): ConnectConfig {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    ...(config.password === undefined ? {} : { password: config.password }),
    readyTimeout: 20_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer): boolean => {
      const fingerprint = fingerprintHostKey(key);
      const matches = config.trustedHostFingerprint === undefined
        || config.trustedHostFingerprint === fingerprint;
      onFingerprint(fingerprint, matches);
      return matches;
    },
  };
}

async function finishConnection(
  client: Client,
  config: SshProxyConnectionConfig,
  fingerprint: string | undefined,
  version: number,
): Promise<LocalSocksProxy> {
  if (sshClient !== client || version !== lifecycleVersion) {
    throw new Error('SSH proxy connection was canceled.');
  }
  if (fingerprint !== undefined && config.trustedHostFingerprint === undefined) {
    await saveTrustedSshHostFingerprint(fingerprint);
  }
  const port = await startSocksServer(client);
  if (sshClient !== client || version !== lifecycleVersion) {
    throw new Error('SSH proxy connection was canceled.');
  }
  activeIdentity = connectionIdentity(config);
  activeProxy = { host: '127.0.0.1', port };
  updateStatus({ ...await buildBaseStatus('connected'), localPort: port });
  logInfo(`[SshProxy] Connected; Cloud Foundry traffic will use SOCKS5 on 127.0.0.1:${port.toString()}.`);
  return activeProxy;
}

async function startSocksServer(client: Client): Promise<number> {
  const protocol = createServer();
  protocol.setConnectionHandler((connection, sendStatus) => {
    if (connection.command !== 'connect') {
      sendStatus('COMMAND_NOT_SUPPORTED');
      return;
    }
    client.forwardOut('127.0.0.1', 0, connection.destAddress, connection.destPort, (error, channel) => {
      if (error) {
        sendStatus('HOST_UNREACHABLE');
        return;
      }
      sendStatus('REQUEST_GRANTED');
      pipeProxyStreams(connection.socket, channel);
    });
  });
  const server = createNetServer((socket) => {
    socket.setNoDelay();
    protocol._handleConnection(socket);
  });
  socksServer = server;
  return listenOnLoopback(server);
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      server.removeListener('error', fail);
      reject(error);
    };
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', fail);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not allocate a local SOCKS port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function pipeProxyStreams(socket: Duplex, channel: ClientChannel): void {
  activeStreams.add(socket);
  activeStreams.add(channel);
  const cleanup = (): void => {
    activeStreams.delete(socket);
    activeStreams.delete(channel);
  };
  socket.once('close', cleanup);
  channel.once('close', cleanup);
  socket.pipe(channel);
  channel.pipe(socket);
}

function bindConnectedClientLifecycle(client: Client): void {
  client.once('close', () => {
    if (sshClient !== client) return;
    const message = 'SSH proxy connection closed.';
    void handleConnectionFailure(client, message);
  });
  client.on('error', (error: Error) => {
    if (sshClient !== client) return;
    void handleConnectionFailure(client, sanitizeError(error));
  });
}

async function handleConnectionFailure(
  client: Client,
  message: string,
): Promise<void> {
  if (sshClient !== client) return;
  await closeRuntime();
  updateStatus({ ...await buildBaseStatus('error'), message });
  logWarn(`[SshProxy] ${message}`);
}

async function closeRuntime(): Promise<void> {
  const cancel = cancelPendingConnection;
  cancelPendingConnection = undefined;
  cancel?.();
  for (const stream of activeStreams) stream.destroy();
  activeStreams.clear();
  const server = socksServer;
  socksServer = undefined;
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  const client = sshClient;
  sshClient = undefined;
  client?.end();
  activeProxy = undefined;
  activeIdentity = undefined;
}

export async function stopSshProxy(): Promise<void> {
  lifecycleVersion += 1;
  const pending = connecting;
  await closeRuntime();
  await pending?.catch(() => undefined);
  updateStatus({
    enabled: status.enabled,
    host: status.host,
    port: status.port,
    username: status.username,
    hasPassword: status.hasPassword,
    connection: status.enabled ? 'disconnected' : 'disabled',
  });
}

export async function refreshSshProxyStatus(): Promise<SshProxyStatus> {
  const settings = await getSshProxyPublicSettings();
  const connection = !settings.enabled
    ? 'disabled'
    : activeProxy === undefined
      ? (status.connection === 'error' ? 'error' : 'disconnected')
      : 'connected';
  const next: SshProxyStatus = { ...settings, connection };
  if (activeProxy !== undefined) next.localPort = activeProxy.port;
  if (status.connection === 'error' && status.message !== undefined) next.message = status.message;
  updateStatus(next);
  return next;
}

export async function disposeSshProxy(): Promise<void> {
  lifecycleVersion += 1;
  await closeRuntime();
  await connecting?.catch(() => undefined);
  sshProxyEvents.removeAllListeners();
}
