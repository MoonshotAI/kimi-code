import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writePrivateFile } from './privateFiles';

export interface TokenStore {
  readonly tokenPath: string;
  getToken(): string;
  isValid(candidate: string): boolean;
  dispose(): Promise<void>;
}

export async function createTokenStore(
  homeDir: string,
  pid: number,
): Promise<TokenStore> {
  const token = randomBytes(32).toString('base64url');
  const tokenPath = join(homeDir, `server-${pid}.token`);
  const tokenBuf = Buffer.from(token);

  await writePrivateFile(tokenPath, token);

  return {
    tokenPath,
    getToken(): string {
      return token;
    },
    isValid(candidate: string): boolean {
      const candidateBuf = Buffer.from(candidate);
      if (candidateBuf.length !== tokenBuf.length) {
        return false;
      }
      return timingSafeEqual(candidateBuf, tokenBuf);
    },
    async dispose(): Promise<void> {
      await rm(tokenPath, { force: true });
    },
  };
}
