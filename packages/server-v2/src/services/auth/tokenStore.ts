/**
 * Persistent token store backed by `<homeDir>/server.token`.
 */

import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { loadOrCreateServerToken, serverTokenPath } from './persistentToken';

export interface TokenStore {
  readonly tokenPath: string;
  getToken(): string;
  isValid(candidate: string): boolean;
  dispose(): Promise<void>;
}

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
      // keep last known token
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
      // Persistent token: intentionally left on disk so it survives restarts.
    },
  };
}
