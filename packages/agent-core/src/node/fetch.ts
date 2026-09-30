import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';

type Env = Readonly<Record<string, string | undefined>>;

const MAX_HEADERS_TIMEOUT_MS = 2 ** 31 - 1;
const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;
const PROXY_ENV_KEYS = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

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

function isSocks(value: string | undefined): boolean {
  return value !== undefined && SOCKS_SCHEMES.has(schemeOf(value) ?? '');
}

function httpProxyOf(env: Env, keys: readonly string[]): string | undefined {
  const value = firstNonBlank(env, keys);
  return isSocks(value) ? undefined : value;
}

function noProxyOf(env: Env): string {
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

let cached: { readonly key: string; readonly dispatcher: Dispatcher | undefined } | undefined;

export function headersTimeoutDispatcher(
  timeoutMs: number,
  env: Env = process.env,
): Dispatcher | undefined {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_HEADERS_TIMEOUT_MS) {
    throw new Error(
      `headers timeout must be a positive integer no greater than ${MAX_HEADERS_TIMEOUT_MS}, got ${timeoutMs}.`,
    );
  }
  const key = JSON.stringify([timeoutMs, ...PROXY_ENV_KEYS.map((name) => env[name])]);
  if (cached?.key === key) return cached.dispatcher;
  const allProxy = httpProxyOf(env, ['all_proxy', 'ALL_PROXY']);
  const httpProxy = httpProxyOf(env, ['http_proxy', 'HTTP_PROXY']) ?? allProxy;
  const httpsProxy = httpProxyOf(env, ['https_proxy', 'HTTPS_PROXY']) ?? allProxy;
  let dispatcher: Dispatcher | undefined;
  if (httpProxy !== undefined || httpsProxy !== undefined) {
    try {
      dispatcher = new EnvHttpProxyAgent({
        httpProxy: httpProxy ?? '',
        httpsProxy: httpsProxy ?? '',
        noProxy: noProxyOf(env),
        headersTimeout: timeoutMs,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.emitWarning(
        `ignoring invalid proxy configuration (${reason}); requests keep the default headers timeout`,
      );
    }
  } else if (
    [
      firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
      firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
      firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
    ].some(isSocks)
  ) {
    process.emitWarning(
      'headers timeout is not supported with SOCKS proxies; requests keep the default headers timeout',
    );
  } else {
    dispatcher = new Agent({ headersTimeout: timeoutMs });
  }
  cached = { key, dispatcher };
  return dispatcher;
}

export function createHeadersTimeoutFetch(timeoutMs: number, env: Env = process.env): typeof fetch {
  const dispatcher = headersTimeoutDispatcher(timeoutMs, env);
  if (dispatcher === undefined) return fetch;
  return (input, init) => fetch(input, { ...init, dispatcher } as unknown as RequestInit);
}
