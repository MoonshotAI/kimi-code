/**
 * Local server-token discovery for Node runtimes.
 *
 * `server-v2` persists its bearer token at `<KIMI_CODE_HOME>/server.token`
 * (mode 0600). When a `ServerClient` is constructed without an explicit
 * `token`, we read this file so a local client authenticates against a local
 * server with zero configuration. In a browser (no `node:fs`) discovery is a
 * no-op and resolves to `undefined`.
 *
 * The default home dir matches `agent-core-v2`'s `resolveKimiHome`:
 *   homeDir ?? env.KIMI_CODE_HOME ?? join(os.homedir(), '.kimi-code')
 */
export const SERVER_TOKEN_FILE = 'server.token';

/** Where a resolved token came from. */
export type TokenSource = 'explicit' | 'file' | 'none';

export interface TokenResolution {
  /** The resolved bearer token, or `undefined` when none could be found. */
  readonly token: string | undefined;
  /** How the token was obtained. */
  readonly source: TokenSource;
  /** Absolute path of the token file when `source === 'file'`. */
  readonly tokenPath?: string;
}

/** `true` when running under Node.js (i.e. `node:fs`/`node:os` are reachable). */
function isNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    typeof (process as { versions?: { node?: string } }).versions?.node === 'string'
  );
}

/** Resolve the Kimi home directory (matches server-v2's `resolveKimiHome`). */
export async function resolveKimiHome(homeDir?: string): Promise<string> {
  if (homeDir !== undefined && homeDir.length > 0) return homeDir;
  const envHome =
    typeof process !== 'undefined' ? process.env?.['KIMI_CODE_HOME'] : undefined;
  if (envHome !== undefined && envHome.length > 0) return envHome;
  if (!isNode()) return '.kimi-code';
  const [{ homedir }, path] = await Promise.all([import('node:os'), import('node:path')]);
  return path.join(homedir(), '.kimi-code');
}

/** Absolute path of the persistent token file for a given home dir. */
export async function serverTokenPath(homeDir?: string): Promise<string> {
  const home = await resolveKimiHome(homeDir);
  if (!isNode()) return `${home}/${SERVER_TOKEN_FILE}`;
  const path = await import('node:path');
  return path.join(home, SERVER_TOKEN_FILE);
}

/**
 * Read `<home>/server.token` in Node. Resolves to `source: 'none'` when the
 * file is missing/empty or when `node:fs` is unavailable (browser). Never
 * throws for a missing file; a malformed/unreadable file also degrades to
 * `none` so the caller can fall back to an explicit token.
 */
export async function loadLocalServerToken(homeDir?: string): Promise<TokenResolution> {
  if (!isNode()) return { token: undefined, source: 'none' };
  try {
    const { readFile } = await import('node:fs/promises');
    const tokenPath = await serverTokenPath(homeDir);
    const raw = await readFile(tokenPath, 'utf8');
    const token = raw.trim();
    if (token.length === 0) return { token: undefined, source: 'none', tokenPath };
    return { token, source: 'file', tokenPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { token: undefined, source: 'none' };
    }
    return { token: undefined, source: 'none' };
  }
}

/** A memoized token source shared by every transport on a `ServerClient`. */
export interface TokenProvider {
  /** The bearer token to send, or `undefined` for unauthenticated requests. */
  getToken(): Promise<string | undefined>;
  /** Resolve (and cache) the token + its source for diagnostics. */
  resolve(): Promise<TokenResolution>;
}

export interface TokenProviderOptions {
  /** Explicit token — takes precedence over local discovery. */
  readonly token?: string;
  /** Override the Kimi home dir used for local discovery. */
  readonly homeDir?: string;
  /** Opt out of local discovery entirely (e.g. for browser builds). */
  readonly disableLocalToken?: boolean;
}

/** Build a memoized {@link TokenProvider}. Discovery runs at most once. */
export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  let cached: Promise<TokenResolution> | undefined;
  const resolve = (): Promise<TokenResolution> => {
    if (cached !== undefined) return cached;
    cached = (async (): Promise<TokenResolution> => {
      if (opts.token !== undefined && opts.token.length > 0) {
        return { token: opts.token, source: 'explicit' };
      }
      if (opts.disableLocalToken === true) {
        return { token: undefined, source: 'none' };
      }
      return loadLocalServerToken(opts.homeDir);
    })();
    return cached;
  };
  return {
    getToken: async () => (await resolve()).token,
    resolve,
  };
}
