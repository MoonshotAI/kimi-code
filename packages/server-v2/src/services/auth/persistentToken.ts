/**
 * Persistent server bearer token stored under KIMI_CODE_HOME.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { readPrivateFile, writePrivateFile } from './privateFiles';

export const SERVER_TOKEN_FILE = 'server.token';

export function serverTokenPath(homeDir: string): string {
  return join(homeDir, SERVER_TOKEN_FILE);
}

export function generateServerToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function writeServerToken(homeDir: string, token: string): Promise<void> {
  await writePrivateFile(serverTokenPath(homeDir), token);
}

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

export async function loadOrCreateServerToken(homeDir: string): Promise<string> {
  const existing = await readServerToken(homeDir);
  if (existing !== undefined && existing.length > 0) {
    return existing;
  }
  const token = generateServerToken();
  await writeServerToken(homeDir, token);
  return token;
}

export async function rotateServerToken(homeDir: string): Promise<string> {
  const token = generateServerToken();
  await writeServerToken(homeDir, token);
  return token;
}
