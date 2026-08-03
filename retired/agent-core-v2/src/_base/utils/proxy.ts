/**
 * Resolve and install proxy configuration for outbound `fetch` and spawned
 * child processes (HTTP/HTTPS and SOCKS, honoring `NO_PROXY`).
 */

import {
  Agent,
  buildConnector,
  type Dispatcher,
  EnvHttpProxyAgent,
  setGlobalDispatcher as undiciSetGlobalDispatcher,
} from 'undici';
import { SocksClient } from 'socks';

type Env = Readonly<Record<string, string | undefined>>;

export interface SocksProxyConfig {
  readonly type: 4 | 5;
  readonly host: string;
  readonly port: number;
  readonly userId?: string;
  readonly password?: string;
}

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;

const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);

function schemeOf(value: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
}

function firstNonBlank(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function httpSchemeValue(value: string | undefined): string | undefined {
  return value !== undefined && !SOCKS_SCHEMES.has(schemeOf(value) ?? '') ? value : undefined;
}

function hasHttpProxy(env: Env): boolean {
  return [
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
  ].some((value) => httpSchemeValue(value) !== undefined);
}

function resolveHttpProxyUrls(env: Env): { httpProxy?: string; httpsProxy?: string } {
  const allProxy = httpSchemeValue(firstNonBlank(env, ['all_proxy', 'ALL_PROXY']));
  return {
    httpProxy: httpSchemeValue(firstNonBlank(env, ['http_proxy', 'HTTP_PROXY'])) ?? allProxy,
    httpsProxy: httpSchemeValue(firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY'])) ?? allProxy,
  };
}

export function resolveSocksProxy(env: Env): SocksProxyConfig | undefined {
  const candidates = [
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
  ];
  for (const value of candidates) {
    if (value === undefined) continue;
    const scheme = schemeOf(value);
    if (scheme === undefined || !SOCKS_SCHEMES.has(scheme)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const config: SocksProxyConfig = {
      type: scheme === 'socks4' || scheme === 'socks4a' ? 4 : 5,
      host: url.hostname.replaceAll(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 1080,
      ...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    };
    return config;
  }
  return undefined;
}

export function isProxyConfigured(env: Env): boolean {
  return hasHttpProxy(env) || resolveSocksProxy(env) !== undefined;
}

export function resolveNoProxy(env: Env): string {
  const raw = [env['no_proxy'], env['NO_PROXY']].find((value) => (value?.trim() ?? '').length > 0) ?? '';
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (hosts.includes('*')) return '*';
  for (const loopback of LOOPBACK_NO_PROXY) {
    if (!hosts.includes(loopback)) hosts.push(loopback);
  }
  return hosts.join(',');
}

export function makeNoProxyMatcher(noProxy: string): (host: string, port?: number | string) => boolean {
  const entries = noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.includes('*')) return () => true;
  const parsed = entries.map(parseNoProxyEntry);
  return (host: string, port?: number | string) => {
    const target = host.toLowerCase().replaceAll(/^\[|\]$/g, '');
    const targetPort = port === undefined ? undefined : String(port);
    return parsed.some(
      ({ host: entry, port: entryPort }) =>
        (entryPort === undefined || entryPort === targetPort) &&
        (target === entry || target.endsWith(`.${entry}`)),
    );
  };
}

function parseNoProxyEntry(entry: string): { host: string; port?: string } {
  let host = entry;
  let port: string | undefined;
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    host = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    if (rest.startsWith(':')) port = rest.slice(1);
  } else {
    const colon = entry.indexOf(':');
    if (colon !== -1 && colon === entry.lastIndexOf(':') && /^\d+$/.test(entry.slice(colon + 1))) {
      host = entry.slice(0, colon);
      port = entry.slice(colon + 1);
    }
  }
  if (host.startsWith('*.')) host = host.slice(2);
  else if (host.startsWith('.')) host = host.slice(1);
  return port === undefined ? { host } : { host, port };
}

export interface ProxyAgentFactories {
  readonly makeHttpAgent: (options: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy: string;
  }) => Dispatcher;
  readonly makeSocksAgent: (options: { proxy: SocksProxyConfig; noProxy: string }) => Dispatcher;
}

const defaultMakeHttpAgent: ProxyAgentFactories['makeHttpAgent'] = ({ httpProxy, httpsProxy, noProxy }) =>
  new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });

const defaultMakeSocksAgent: ProxyAgentFactories['makeSocksAgent'] = ({ proxy, noProxy }) => {
  const directConnect = buildConnector({});
  const bypass = makeNoProxyMatcher(noProxy);
  const connect: typeof directConnect = (options, callback) => {
    if (bypass(options.hostname, options.port)) {
      directConnect(options, callback);
      return;
    }
    void (async () => {
      try {
        const isTls = options.protocol === 'https:';
        const port = Number(options.port) || (isTls ? 443 : 80);
        const { socket } = await SocksClient.createConnection({
          proxy: { host: proxy.host, port: proxy.port, type: proxy.type, userId: proxy.userId, password: proxy.password },
          command: 'connect',
          destination: { host: options.hostname, port },
        });
        if (isTls) {
          directConnect({ ...options, httpSocket: socket } as Parameters<typeof directConnect>[0], callback);
        } else {
          socket.setNoDelay(true);
          callback(null, socket);
        }
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), null);
      }
    })();
  };
  return new Agent({ connect });
};

export function createProxyDispatcher(
  env: Env,
  factories: Partial<ProxyAgentFactories> = {},
): Dispatcher | undefined {
  const { makeHttpAgent = defaultMakeHttpAgent, makeSocksAgent = defaultMakeSocksAgent } = factories;
  try {
    if (hasHttpProxy(env)) {
      const { httpProxy, httpsProxy } = resolveHttpProxyUrls(env);
      return makeHttpAgent({
        httpProxy: httpProxy ?? '',
        httpsProxy: httpsProxy ?? '',
        noProxy: resolveNoProxy(env),
      });
    }
    const socks = resolveSocksProxy(env);
    if (socks !== undefined) {
      return makeSocksAgent({ proxy: socks, noProxy: resolveNoProxy(env) });
    }
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kimi: ignoring invalid proxy configuration (${reason}); connecting directly\n`);
    return undefined;
  }
}

export interface InstallProxyDeps {
  readonly setGlobalDispatcher: (dispatcher: Dispatcher) => void;
  readonly createProxyDispatcher: (env: Env) => Dispatcher | undefined;
}

const defaultInstallProxyDeps: InstallProxyDeps = {
  setGlobalDispatcher: undiciSetGlobalDispatcher,
  createProxyDispatcher,
};

export function installGlobalProxyDispatcher(
  env: Env,
  deps: InstallProxyDeps = defaultInstallProxyDeps,
): boolean {
  const dispatcher = deps.createProxyDispatcher(env);
  if (dispatcher === undefined) return false;
  deps.setGlobalDispatcher(dispatcher);
  return true;
}

export function proxyEnvForChild(env: Env): Record<string, string> {
  if (!hasHttpProxy(env)) return {};
  const noProxy = resolveNoProxy(env);
  const result: Record<string, string> = {
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  const { httpProxy, httpsProxy } = resolveHttpProxyUrls(env);
  if (httpProxy !== undefined) {
    result['HTTP_PROXY'] = httpProxy;
    result['http_proxy'] = httpProxy;
  }
  if (httpsProxy !== undefined) {
    result['HTTPS_PROXY'] = httpsProxy;
    result['https_proxy'] = httpsProxy;
  }
  return result;
}

export function reconcileChildNoProxy(
  childEnv: Record<string, string>,
  configEnv?: Record<string, string>,
): void {
  const override = [configEnv?.['no_proxy'], configEnv?.['NO_PROXY']].find(
    (value) => (value?.trim() ?? '').length > 0,
  );
  if (override === undefined) return;
  const noProxy = resolveNoProxy({ no_proxy: override, NO_PROXY: override });
  childEnv['NO_PROXY'] = noProxy;
  childEnv['no_proxy'] = noProxy;
}
