import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { loadOrCreateServerToken, serverTokenPath } from './persistentToken';

export interface TokenStore {
  readonly tokenPath: string;
  getToken(): string;
  isValid(candidate: string): boolean;
  dispose(): Promise<void>;
}

/**
 * Persistent token store over `<homeDir>/server.token`.
 *
 * The token is loaded (or generated) once at boot and reused across restarts.
 * `getToken()`/`isValid()` re-read the file whenever its mtime changes, so a
 * `kimi web rotate-token` (which rewrites the file) takes effect on a
 * running server immediately — no restart, no extra API. The file is small
 * (43 bytes) and the common path is a single `statSync` per check.
 *
 * `dispose()` is intentionally a no-op: the token must survive shutdown.
 */
export async function createTokenStore(homeDir: string): Promise<TokenStore> {
  const tokenPath = serverTokenPath(homeDir);
  const initial = await loadOrCreateServerToken(homeDir);
  const initialStat = statSync(tokenPath);
  let cache: { token: string; mtimeMs: number; ino: number } = {
    token: initial,
    mtimeMs: initialStat.mtimeMs,
    ino: initialStat.ino,
  };

  const currentToken = (): string => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(tokenPath);
    } catch {
      return cache.token;
    }
    if (st.mtimeMs === cache.mtimeMs && st.ino === cache.ino) {
      return cache.token;
    }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      return cache.token;
    }
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      if (token.length > 0) {
        cache = { token, mtimeMs: st.mtimeMs, ino: st.ino };
      }
    } catch {
    }
    return cache.token;
  };

  return {
    tokenPath,
    getToken: currentToken,
    isValid(candidate: string): boolean {
      const tokenBuf = Buffer.from(currentToken());
      const candidateBuf = Buffer.from(candidate);
      if (candidateBuf.length !== tokenBuf.length) {
        return false;
      }
      return timingSafeEqual(candidateBuf, tokenBuf);
    },
    async dispose(): Promise<void> {
    },
  };
}
