import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockSshClient extends EventEmitter {
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  forwardOut: ReturnType<typeof vi.fn>;
}

interface MockSocksServer {
  setConnectionHandler: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _handleConnection: ReturnType<typeof vi.fn>;
}

interface MockNetServer extends EventEmitter {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
  connectionHandler: (socket: { setNoDelay: ReturnType<typeof vi.fn> }) => void;
}

interface MockProxyConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password?: string;
  trustedHostFingerprint?: string;
}

const mocks = vi.hoisted(() => ({
  clients: [] as MockSshClient[],
  servers: [] as MockSocksServer[],
  netServers: [] as MockNetServer[],
  nextListenError: undefined as Error | undefined,
  getConfig: vi.fn<() => Promise<MockProxyConfig>>(),
  getPublicSettings: vi.fn(),
  saveFingerprint: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: (
    connectionHandler: (socket: { setNoDelay: ReturnType<typeof vi.fn> }) => void,
  ): MockNetServer => {
    const server = new EventEmitter() as MockNetServer;
    server.connectionHandler = connectionHandler;
    server.listen = vi.fn((_port: number, _host: string, callback: () => void) => {
      const error = mocks.nextListenError;
      mocks.nextListenError = undefined;
      if (error !== undefined) server.emit('error', error);
      else callback();
      return server;
    });
    server.close = vi.fn((callback?: (error?: Error) => void) => {
      callback?.();
      return server;
    });
    server.address = vi.fn(() => ({
      address: '127.0.0.1',
      family: 'IPv4',
      port: 49152,
    }));
    mocks.netServers.push(server);
    return server;
  },
}));

vi.mock('ssh2', () => ({
  Client: class extends EventEmitter implements MockSshClient {
    connect = vi.fn();
    end = vi.fn();
    destroy = vi.fn();
    forwardOut = vi.fn();

    constructor() {
      super();
      mocks.clients.push(this);
    }
  },
}));

vi.mock('@pondwader/socks5-server', () => ({
  createServer: (): MockSocksServer => {
    const server: MockSocksServer = {
      setConnectionHandler: vi.fn().mockReturnThis(),
      listen: vi.fn((_port: number, _host: string, callback: () => void) => {
        callback();
        return server;
      }),
      close: vi.fn((callback?: () => void) => {
        callback?.();
        return server;
      }),
      _handleConnection: vi.fn().mockReturnThis(),
    };
    mocks.servers.push(server);
    return server;
  },
}));

vi.mock('../../src/storage/sshProxyStore', () => ({
  getSshProxyConnectionConfig: mocks.getConfig,
  getSshProxyPublicSettings: mocks.getPublicSettings,
  saveTrustedSshHostFingerprint: mocks.saveFingerprint,
}));

vi.mock('../../src/core/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  ensureSshProxy,
  getSshProxyStatus,
  stopSshProxy,
} from '../../src/core/sshProxyTunnel';

function configuredProxy(trustedHostFingerprint?: string): MockProxyConfig {
  return {
    enabled: true,
    host: 'home.example.com',
    port: 44322,
    username: 'dongtran',
    password: 'secret',
    ...(trustedHostFingerprint === undefined ? {} : { trustedHostFingerprint }),
  };
}

async function waitForClient(): Promise<MockSshClient> {
  await vi.waitFor(() => {
    expect(mocks.clients).toHaveLength(1);
  });
  const client = mocks.clients[0];
  if (client === undefined) throw new Error('Expected an SSH client');
  return client;
}

function firstServer(): MockSocksServer {
  const server = mocks.servers[0];
  if (server === undefined) throw new Error('Expected a SOCKS server');
  return server;
}

function firstNetServer(): MockNetServer {
  const server = mocks.netServers[0];
  if (server === undefined) throw new Error('Expected a loopback server');
  return server;
}

function readConnectOptions(client: MockSshClient): {
  hostVerifier: (key: Buffer) => boolean;
  password?: string;
} {
  const options: unknown = client.connect.mock.calls[0]?.[0];
  if (typeof options !== 'object' || options === null || !('hostVerifier' in options)) {
    throw new Error('Expected SSH connect options');
  }
  return options as { hostVerifier: (key: Buffer) => boolean; password?: string };
}

describe('sshProxyTunnel', () => {
  beforeEach(async () => {
    await stopSshProxy();
    mocks.clients.length = 0;
    mocks.servers.length = 0;
    mocks.netServers.length = 0;
    mocks.nextListenError = undefined;
    mocks.getConfig.mockReset();
    mocks.getPublicSettings.mockReset().mockImplementation(() => (
      mocks.getConfig().then((config) => ({
        enabled: config.enabled,
        host: config.host,
        port: config.port,
        username: config.username,
        hasPassword: typeof config.password === 'string' && config.password.length > 0,
      }))
    ));
    mocks.saveFingerprint.mockReset().mockResolvedValue(undefined);
    delete process.env.CDS_DEBUG_E2E_MODE;
    delete process.env.CDS_DEBUG_E2E_SSH_PROXY_RESULT;
  });

  it('does not connect when the proxy is disabled', async () => {
    mocks.getConfig.mockResolvedValue({
      enabled: false,
      host: '',
      port: 22,
      username: '',
    });

    await expect(ensureSshProxy()).resolves.toBeUndefined();
    expect(mocks.clients).toHaveLength(0);
    expect(getSshProxyStatus().connection).toBe('disabled');
  });

  it('rejects enabled settings without a stored password', async () => {
    mocks.getConfig.mockResolvedValue({
      enabled: true,
      host: 'home.example.com',
      port: 44322,
      username: 'dongtran',
    });

    await expect(ensureSshProxy()).rejects.toThrow('password is not configured');
    expect(getSshProxyStatus()).toMatchObject({
      connection: 'error',
      message: 'SSH proxy password is not configured.',
    });
  });

  it('uses a deterministic tunnel only inside the E2E boundary', async () => {
    mocks.getConfig.mockResolvedValue(configuredProxy());
    process.env.CDS_DEBUG_E2E_MODE = '1';
    process.env.CDS_DEBUG_E2E_SSH_PROXY_RESULT = 'success';

    await expect(ensureSshProxy()).resolves.toEqual({ host: '127.0.0.1', port: 49152 });
    expect(mocks.clients).toHaveLength(0);
    expect(getSshProxyStatus().connection).toBe('connected');
  });

  it('deduplicates concurrent connection attempts and stores the first fingerprint', async () => {
    mocks.getConfig.mockResolvedValue(configuredProxy());

    const first = ensureSshProxy();
    const second = ensureSshProxy();
    const client = await waitForClient();
    const connectOptions = readConnectOptions(client);

    expect(connectOptions.password).toBe('secret');
    expect(connectOptions.hostVerifier(Buffer.from('server-key'))).toBe(true);
    client.emit('ready');

    await expect(Promise.all([first, second])).resolves.toEqual([
      { host: '127.0.0.1', port: 49152 },
      { host: '127.0.0.1', port: 49152 },
    ]);
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.saveFingerprint).toHaveBeenCalledWith(expect.stringMatching(/^SHA256:/));
    expect(firstNetServer().listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
    expect(getSshProxyStatus()).toMatchObject({
      connection: 'connected',
      localPort: 49152,
    });
    expect(client.listenerCount('error')).toBe(1);
  });

  it('cancels an in-flight handshake and allows a clean reconnect', async () => {
    mocks.getConfig.mockResolvedValue(configuredProxy());

    const firstConnection = ensureSshProxy();
    const firstClient = await waitForClient();

    await stopSshProxy();
    await expect(firstConnection).rejects.toThrow('connection was canceled');
    expect(firstClient.end).toHaveBeenCalledTimes(1);

    const secondConnection = ensureSshProxy();
    await vi.waitFor(() => {
      expect(mocks.clients).toHaveLength(2);
    });
    const secondClient = mocks.clients[1];
    if (secondClient === undefined) throw new Error('Expected a replacement SSH client');
    readConnectOptions(secondClient).hostVerifier(Buffer.from('server-key'));
    secondClient.emit('ready');

    await expect(secondConnection).resolves.toEqual({ host: '127.0.0.1', port: 49152 });
  });

  it('rejects a changed SSH host key', async () => {
    mocks.getConfig.mockResolvedValue(configuredProxy('SHA256:known-host'));

    const connecting = ensureSshProxy();
    const client = await waitForClient();
    const connectOptions = readConnectOptions(client);

    expect(connectOptions.hostVerifier(Buffer.from('different-key'))).toBe(false);
    client.emit('error', new Error('Host key verification failed'));

    await expect(connecting).rejects.toThrow('SSH host key changed');
    expect(mocks.servers).toHaveLength(0);
    expect(getSshProxyStatus()).toMatchObject({
      connection: 'error',
      message: expect.stringContaining('host key changed'),
    });
  });

  it('forwards SOCKS connections through SSH forwardOut', async () => {
    mocks.getConfig.mockResolvedValue(configuredProxy());
    const connecting = ensureSshProxy();
    const client = await waitForClient();
    const connectOptions = readConnectOptions(client);
    connectOptions.hostVerifier(Buffer.from('server-key'));
    client.emit('ready');
    await connecting;

    const handler = firstServer().setConnectionHandler.mock.calls[0]?.[0] as (
      connection: { socket: Duplex; destAddress: string; destPort: number; command: string },
      sendStatus: (status: string) => void,
    ) => void;
    const socket = new EventEmitter() as Duplex;
    const socketPipe = vi.fn().mockReturnValue(socket);
    socket.pipe = socketPipe;
    socket.destroy = vi.fn().mockReturnValue(socket);
    const channel = new EventEmitter() as Duplex;
    const channelPipe = vi.fn().mockReturnValue(channel);
    channel.pipe = channelPipe;
    channel.destroy = vi.fn().mockReturnValue(channel);
    const sendStatus = vi.fn();
    const loopbackSocket = { setNoDelay: vi.fn() };
    firstNetServer().connectionHandler(loopbackSocket);
    expect(loopbackSocket.setNoDelay).toHaveBeenCalledTimes(1);
    expect(firstServer()._handleConnection).toHaveBeenCalledWith(loopbackSocket);

    client.forwardOut.mockImplementation(
      (_sourceHost: string, _sourcePort: number, _host: string, _port: number, callback: (error: Error | undefined, stream: Duplex) => void) => {
        callback(undefined, channel);
      },
    );

    handler({
      socket,
      destAddress: 'api.cf.eu10.hana.ondemand.com',
      destPort: 443,
      command: 'connect',
    }, sendStatus);

    expect(client.forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      'api.cf.eu10.hana.ondemand.com',
      443,
      expect.any(Function),
    );
    expect(sendStatus).toHaveBeenCalledWith('REQUEST_GRANTED');
    expect(socketPipe).toHaveBeenCalledWith(channel);
    expect(channelPipe).toHaveBeenCalledWith(socket);

    const unsupportedStatus = vi.fn();
    handler({
      socket,
      destAddress: 'api.cf.eu10.hana.ondemand.com',
      destPort: 443,
      command: 'bind',
    }, unsupportedStatus);
    expect(unsupportedStatus).toHaveBeenCalledWith('COMMAND_NOT_SUPPORTED');

    client.forwardOut.mockImplementation(
      (_sourceHost: string, _sourcePort: number, _host: string, _port: number, callback: (error: Error | undefined, stream: Duplex) => void) => {
        callback(new Error('unreachable'), channel);
      },
    );
    const failedStatus = vi.fn();
    handler({
      socket,
      destAddress: 'unreachable.example.com',
      destPort: 443,
      command: 'connect',
    }, failedStatus);
    expect(failedStatus).toHaveBeenCalledWith('HOST_UNREACHABLE');
  });

  it('reports a local SOCKS listener failure without leaving the handshake pending', async () => {
    mocks.getConfig.mockResolvedValue(configuredProxy());
    mocks.nextListenError = new Error('address already in use');

    const connecting = ensureSshProxy();
    const client = await waitForClient();
    readConnectOptions(client).hostVerifier(Buffer.from('server-key'));
    client.emit('ready');

    await expect(connecting).rejects.toThrow('address already in use');
    await vi.waitFor(() => {
      expect(getSshProxyStatus()).toMatchObject({
        connection: 'error',
        message: 'address already in use',
      });
    });
  });

  it('cleans up and reports an unexpected connected-session close', async () => {
    mocks.getConfig.mockResolvedValue(configuredProxy());
    const connecting = ensureSshProxy();
    const client = await waitForClient();
    readConnectOptions(client).hostVerifier(Buffer.from('server-key'));
    client.emit('ready');
    await connecting;

    client.emit('close');

    await vi.waitFor(() => {
      expect(getSshProxyStatus()).toMatchObject({
        connection: 'error',
        message: 'SSH proxy connection closed.',
      });
    });
    expect(firstNetServer().close).toHaveBeenCalledTimes(1);
  });

  it('stops the SOCKS server and SSH connection', async () => {
    mocks.getConfig.mockResolvedValue(configuredProxy());
    const connecting = ensureSshProxy();
    const client = await waitForClient();
    const connectOptions = readConnectOptions(client);
    connectOptions.hostVerifier(Buffer.from('server-key'));
    client.emit('ready');
    await connecting;

    await stopSshProxy();

    expect(firstNetServer().close).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(getSshProxyStatus().connection).toBe('disconnected');
  });
});
