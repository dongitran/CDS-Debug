import { ensureSshProxy } from './sshProxyTunnel';

const PROXY_VARIABLES = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const;

export async function createCfProcessEnv(
  overrides: NodeJS.ProcessEnv = {},
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  const proxy = await ensureSshProxy();
  if (proxy === undefined) return env;

  const proxyUrl = `socks5://${proxy.host}:${proxy.port.toString()}`;
  for (const variable of PROXY_VARIABLES) {
    env[variable] = proxyUrl;
  }
  return env;
}
