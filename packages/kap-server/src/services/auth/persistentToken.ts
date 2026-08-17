import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { readPrivateFile, writePrivateFile } from './privateFiles';

/** On-disk filename for the persistent token, relative to KIMI_CODE_HOME. */
export const SERVER_TOKEN_FILE = 'server.token';

/** Absolute path of the persistent token file for a given home dir. */
export function serverTokenPath(homeDir: string): string {
  return join(homeDir, SERVER_TOKEN_FILE);
}

/** Fresh 256-bit token, base64url-encoded (43 chars, URL-safe). */
export function generateServerToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Atomically write `token` to `<homeDir>/server.token` (0600). */
export async function writeServerToken(homeDir: string, token: string): Promise<void> {
  await writePrivateFile(serverTokenPath(homeDir), token);
}

/**
 * Read the persistent token, or `undefined` when no token file exists yet.
 * Throws if the file exists but is too permissive (not 0600).
 */
export async function readServerToken(homeDir: string): Promise<string | undefined> {
  try {
    const buf = await readPrivateFile(serverTokenPath(homeDir));
    return buf.toString('utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/**
 * Return the existing persistent token, generating and persisting one on first
 * boot. An empty/unreadable file is treated as missing and regenerated.
 */
export async function loadOrCreateServerToken(homeDir: string): Promise<string> {
  const existing = await readServerToken(homeDir);
  if (existing !== undefined && existing.length > 0) {
    return existing;
  }
  const token = generateServerToken();
  await writeServerToken(homeDir, token);
  return token;
}

/**
 * Generate and persist a brand-new token, invalidating the previous one.
 *
 * A running server picks the new token up on its next auth check (the token
 * store re-reads the file when its mtime changes), so rotation takes effect
 * immediately without a restart.
 */
export async function rotateServerToken(homeDir: string): Promise<string> {
  const token = generateServerToken();
  await writeServerToken(homeDir, token);
  return token;
}
