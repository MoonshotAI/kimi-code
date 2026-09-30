type Env = Readonly<Record<string, string | undefined>>;

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

function resolveNoProxy(env: Env): string {
  const raw =
    [env['no_proxy'], env['NO_PROXY']].find((value) => (value?.trim() ?? '').length > 0) ?? '';
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

export function installGlobalProxyDispatcher(env: Env = process.env): boolean {
  const allProxy = httpSchemeValue(firstNonBlank(env, ['all_proxy', 'ALL_PROXY']));
  const httpProxy = httpSchemeValue(firstNonBlank(env, ['http_proxy', 'HTTP_PROXY'])) ?? allProxy;
  const httpsProxy = httpSchemeValue(firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY'])) ?? allProxy;
  if (httpProxy === undefined && httpsProxy === undefined) return false;
  const target = process.env as Record<string, string | undefined>;
  if (httpProxy !== undefined) {
    target['HTTP_PROXY'] ??= httpProxy;
    target['http_proxy'] ??= httpProxy;
  }
  if (httpsProxy !== undefined) {
    target['HTTPS_PROXY'] ??= httpsProxy;
    target['https_proxy'] ??= httpsProxy;
  }
  if (target['NO_PROXY'] === undefined && target['no_proxy'] === undefined) {
    const noProxy = resolveNoProxy(env);
    target['NO_PROXY'] = noProxy;
    target['no_proxy'] = noProxy;
  }
  target['NODE_USE_ENV_PROXY'] = '1';
  return true;
}
