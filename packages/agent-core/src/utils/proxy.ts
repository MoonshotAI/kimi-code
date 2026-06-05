import { type Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher as undiciSetGlobalDispatcher } from 'undici';

type Env = Readonly<Record<string, string | undefined>>;

// Loopback hosts always bypass the proxy. Neither undici's EnvHttpProxyAgent
// nor Node's `--use-env-proxy` exempt loopback by default, so without this a
// user with HTTP_PROXY set would route `http://localhost:PORT` traffic (e.g. a
// local MCP server) through a corporate proxy that refuses loopback — a
// confusing failure that only proxy users would hit.
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1'] as const;

// The standard proxy variables undici honors, in both casings. ALL_PROXY is
// intentionally omitted: EnvHttpProxyAgent has no equivalent option, so
// advertising support for it would mislead.
const PROXY_ENV_KEYS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY'] as const;

/** True when any standard HTTP(S) proxy variable is set to a non-blank value. */
export function isProxyConfigured(env: Env = process.env): boolean {
  return PROXY_ENV_KEYS.some((key) => (env[key]?.trim() ?? '').length > 0);
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

/** Builds the proxy dispatcher; injectable so unit tests avoid real sockets. */
export type ProxyAgentFactory = (options: { noProxy: string }) => Dispatcher;

const defaultProxyAgentFactory: ProxyAgentFactory = ({ noProxy }) =>
  // EnvHttpProxyAgent reads HTTP_PROXY/HTTPS_PROXY from process.env itself; we
  // only override noProxy to guarantee the loopback bypass.
  new EnvHttpProxyAgent({ noProxy });

/**
 * Build an undici dispatcher that routes outbound `fetch` through
 * `HTTP_PROXY`/`HTTPS_PROXY` while honoring the (loopback-augmented)
 * `NO_PROXY`. Returns `undefined` when no proxy variable is set, so the
 * zero-config majority keeps Node's default dispatcher untouched.
 */
export function createProxyDispatcher(
  env: Env = process.env,
  makeAgent: ProxyAgentFactory = defaultProxyAgentFactory,
): Dispatcher | undefined {
  if (!isProxyConfigured(env)) return undefined;
  try {
    return makeAgent({ noProxy: resolveNoProxy(env) });
  } catch (error) {
    // A malformed proxy URL makes EnvHttpProxyAgent throw synchronously. Don't
    // abort startup with a raw stack trace — report it and fall back to direct.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kimi: ignoring invalid HTTP_PROXY/HTTPS_PROXY (${reason}); connecting directly\n`);
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
 * Returns `{}` when no proxy is configured. `NODE_USE_ENV_PROXY` is harmless
 * for non-node children (ignored) and for node children without a proxy var.
 *
 * Sets `NO_PROXY` in BOTH casings: the child inherits the parent's env, and
 * undici reads the lowercase `no_proxy` first — so an inherited un-augmented
 * lowercase value would otherwise defeat the loopback protection.
 */
export function proxyEnvForChild(env: Env = process.env): Record<string, string> {
  if (!isProxyConfigured(env)) return {};
  const noProxy = resolveNoProxy(env);
  return { NODE_USE_ENV_PROXY: '1', NO_PROXY: noProxy, no_proxy: noProxy };
}
