import {
  Agent,
  buildConnector,
  type Dispatcher,
  EnvHttpProxyAgent,
  setGlobalDispatcher as undiciSetGlobalDispatcher,
} from 'undici';
import { SocksClient } from 'socks';

type Env = Readonly<Record<string, string | undefined>>;

/** A parsed SOCKS proxy endpoint, in the shape the `socks` client expects. */
export interface SocksProxyConfig {
  /** SOCKS protocol version: 4 (socks4/socks4a) or 5 (socks/socks5/socks5h). */
  readonly type: 4 | 5;
  readonly host: string;
  readonly port: number;
  readonly userId?: string;
  readonly password?: string;
}

// Loopback hosts always bypass the proxy. Neither undici's EnvHttpProxyAgent,
// Node's `--use-env-proxy`, nor our SOCKS connector exempt loopback by default,
// so without this a user with a proxy set would route `http://localhost:PORT`
// traffic (e.g. a local MCP server) through the proxy — a confusing failure
// that only proxy users would hit.
// `::1` and the bracketed `[::1]` are both listed: undici's EnvHttpProxyAgent
// only bypasses the IPv6 loopback when the NO_PROXY entry is bracketed (it
// otherwise mis-parses `::1` as host `:` port `1`), while our own SOCKS matcher
// normalizes brackets away — so including both covers every path.
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;

const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);

/** Lowercase URL scheme (without the trailing colon), or undefined if absent. */
function schemeOf(value: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
}

/** First non-blank value among `keys` (both casings are passed in by callers). */
function firstNonBlank(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** The value if it is an HTTP/HTTPS-scheme proxy (not SOCKS), else undefined. */
function httpSchemeValue(value: string | undefined): string | undefined {
  return value !== undefined && !SOCKS_SCHEMES.has(schemeOf(value) ?? '') ? value : undefined;
}

/**
 * True when an HTTP/HTTPS-scheme proxy is configured — via `HTTP_PROXY`,
 * `HTTPS_PROXY`, or an http-scheme `ALL_PROXY` (the catch-all fallback).
 */
function hasHttpProxy(env: Env): boolean {
  return [
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
  ].some((value) => httpSchemeValue(value) !== undefined);
}

/**
 * Resolve the effective http/https proxy URLs: the scheme-specific
 * `HTTP_PROXY`/`HTTPS_PROXY` (ignoring a SOCKS-scheme value), falling back to an
 * http-scheme `ALL_PROXY` catch-all. `undefined` for a scheme with no usable
 * value.
 */
function resolveHttpProxyUrls(env: Env): { httpProxy?: string; httpsProxy?: string } {
  const allProxy = httpSchemeValue(firstNonBlank(env, ['all_proxy', 'ALL_PROXY']));
  return {
    httpProxy: httpSchemeValue(firstNonBlank(env, ['http_proxy', 'HTTP_PROXY'])) ?? allProxy,
    httpsProxy: httpSchemeValue(firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY'])) ?? allProxy,
  };
}

/**
 * Resolve a SOCKS proxy from the environment, or `undefined` if none. A SOCKS
 * proxy may be declared via `ALL_PROXY` (the common form for Clash / V2RayN) or
 * by putting a `socks*` scheme in `HTTP(S)_PROXY`. `ALL_PROXY` wins, then
 * `HTTPS_PROXY`, then `HTTP_PROXY`. `socks://` is an alias for `socks5://`.
 */
export function resolveSocksProxy(env: Env = process.env): SocksProxyConfig | undefined {
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
      // Strip IPv6 brackets: the `socks` client wants the bare address (`::1`),
      // not the URL's bracketed `[::1]`, which it would treat as a hostname.
      host: url.hostname.replaceAll(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 1080,
      ...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    };
    return config;
  }
  return undefined;
}

/** True when any HTTP(S) or SOCKS proxy variable is set to a usable value. */
export function isProxyConfigured(env: Env = process.env): boolean {
  return hasHttpProxy(env) || resolveSocksProxy(env) !== undefined;
}

/**
 * The effective `NO_PROXY` with loopback hosts guaranteed present so local
 * traffic stays direct. Reads both casings (lowercase first when non-blank,
 * matching undici), preserves the user's entries, and appends only the missing
 * loopback hosts.
 *
 * The `*` wildcard ("bypass everything") is returned verbatim: undici only
 * honors it as an exact-string match, so appending loopback would silently
 * defeat the user's explicit opt-out and route all non-loopback traffic
 * through the proxy.
 */
export function resolveNoProxy(env: Env = process.env): string {
  // Prefer the first non-blank casing; an empty `no_proxy=''` must not mask a
  // populated `NO_PROXY` (`??` would, since `''` is not nullish).
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

/**
 * Build a predicate that returns true when a host (and optional port) should
 * bypass the proxy, given a `NO_PROXY` string. Matches `*` (all), exact hosts,
 * and subdomains for both bare (`example.com`) and leading-dot (`.example.com`)
 * entries; a port-qualified entry (`host:443`) matches only that port. Used for
 * the SOCKS path, where bypass is not handled by undici for us.
 */
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

/**
 * Split a `NO_PROXY` entry into host (leading `.` stripped) and optional port.
 * Handles bracketed IPv6 (`[::1]:443`) and avoids mistaking a bare IPv6
 * address's colons (`::1`) for a `host:port` separator.
 */
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
    // Only a single colon followed by digits is a port; multiple colons mean a
    // bare IPv6 address (e.g. `::1`), which carries no port.
    if (colon !== -1 && colon === entry.lastIndexOf(':') && /^\d+$/.test(entry.slice(colon + 1))) {
      host = entry.slice(0, colon);
      port = entry.slice(colon + 1);
    }
  }
  // Normalize a wildcard domain (`*.example.com`) and a leading-dot
  // (`.example.com`) to the bare domain; subdomain matching is handled below.
  if (host.startsWith('*.')) host = host.slice(2);
  else if (host.startsWith('.')) host = host.slice(1);
  return port === undefined ? { host } : { host, port };
}

export interface ProxyAgentFactories {
  /** Build the dispatcher for an HTTP/HTTPS proxy. */
  readonly makeHttpAgent: (options: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy: string;
  }) => Dispatcher;
  /** Build the dispatcher for a SOCKS proxy. */
  readonly makeSocksAgent: (options: { proxy: SocksProxyConfig; noProxy: string }) => Dispatcher;
}

const defaultMakeHttpAgent: ProxyAgentFactories['makeHttpAgent'] = ({ httpProxy, httpsProxy, noProxy }) =>
  // Pass the resolved proxy URLs explicitly: left to itself EnvHttpProxyAgent
  // reads `http_proxy ?? HTTP_PROXY`, where a blank lowercase value would mask a
  // populated uppercase one and silently disable proxying. noProxy is likewise
  // pre-resolved to guarantee the loopback bypass.
  new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });

const defaultMakeSocksAgent: ProxyAgentFactories['makeSocksAgent'] = ({ proxy, noProxy }) => {
  // undici has no SOCKS support, so we drive a custom connector: tunnel the
  // destination through the SOCKS proxy with the `socks` client, then hand the
  // established socket back to undici's connector — which performs the TLS
  // upgrade for https targets (reusing undici's ALPN/servername handling).
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
          // Upgrade the SOCKS socket to TLS via undici's own connector.
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

/**
 * Build an undici dispatcher that routes outbound `fetch` through the
 * configured proxy while honoring the (loopback-augmented) `NO_PROXY`. An
 * HTTP/HTTPS proxy takes precedence for matching traffic; otherwise a SOCKS
 * proxy (`ALL_PROXY` or a `socks*` scheme) is used. Returns `undefined` when no
 * proxy variable is set, so the zero-config majority keeps Node's default
 * dispatcher untouched.
 */
export function createProxyDispatcher(
  env: Env = process.env,
  factories: Partial<ProxyAgentFactories> = {},
): Dispatcher | undefined {
  const { makeHttpAgent = defaultMakeHttpAgent, makeSocksAgent = defaultMakeSocksAgent } = factories;
  try {
    if (hasHttpProxy(env)) {
      // Coerce a missing value to '' (falsy to undici) so EnvHttpProxyAgent
      // neither builds a broken agent from a socks: URI nor re-reads a
      // blank-masked value from env.
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
    // A malformed proxy URL makes agent construction throw synchronously. Don't
    // abort startup with a raw stack trace — report it and fall back to direct.
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

/**
 * Install the proxy dispatcher as the process-wide undici dispatcher so every
 * `fetch` — LLM SDKs, in-process MCP HTTP, telemetry, OAuth, web tools, update
 * checks, downloads — honors the proxy. Call once at process startup, before
 * any network use. No-op (returns `false`) when no proxy variable is set.
 */
export function installGlobalProxyDispatcher(
  env: Env = process.env,
  deps: InstallProxyDeps = defaultInstallProxyDeps,
): boolean {
  const dispatcher = deps.createProxyDispatcher(env);
  if (dispatcher === undefined) return false;
  deps.setGlobalDispatcher(dispatcher);
  return true;
}

/**
 * Environment additions for spawned child node processes (e.g. stdio MCP
 * servers) so they honor the proxy natively via Node's `--use-env-proxy`
 * without bundling undici. An in-process global dispatcher is NOT inherited
 * across a process boundary — only env vars are — so children rely on this.
 *
 * Only applies to HTTP/HTTPS proxies: Node's `--use-env-proxy` does not support
 * SOCKS, so a SOCKS-only proxy yields `{}` (child SOCKS proxying is out of
 * scope). Everything is set in BOTH casings: the child inherits the parent's
 * env and undici reads the lowercase form first, so the lowercase variants must
 * also carry the resolved values or the protection/proxying is silently lost.
 *
 * Because `--use-env-proxy` reads `HTTP_PROXY`/`HTTPS_PROXY` (not `ALL_PROXY`),
 * an http-scheme `ALL_PROXY` is synthesized into the scheme-specific variables
 * so an `ALL_PROXY`-only parent still proxies the child.
 */
export function proxyEnvForChild(env: Env = process.env): Record<string, string> {
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

/**
 * Mirror a server config's `NO_PROXY` override onto both casings of the child
 * env. undici reads the lowercase `no_proxy` first, so without this the value
 * {@link proxyEnvForChild} injected in the other casing would shadow an
 * explicit per-server override.
 *
 * Uses the first NON-blank casing (a blank `no_proxy=''` must not mask a
 * populated `NO_PROXY`, mirroring {@link resolveNoProxy}) and runs the value
 * back through {@link resolveNoProxy} so the loopback bypass is preserved and
 * `*` passes through verbatim. No-op when config sets no usable `NO_PROXY`.
 */
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
