import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

import { basename, join } from 'pathe';

export function sanitizeStoreKey(name: string): string {
  const safe = basename(name)
    .replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    .replaceAll(/_+/g, '_');
  if (safe.length === 0 || safe.startsWith('.')) {
    throw new Error(`Invalid MCP OAuth store key: "${name}"`);
  }
  return safe;
}

export function canonicalMcpOAuthResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

export function mcpOAuthStoreKey(serverName: string, serverUrl: string | URL): string {
  const safeName = sanitizeStoreKey(serverName);
  const resource = canonicalMcpOAuthResource(serverUrl);
  const digest = createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(resource)
    .digest('hex')
    .slice(0, 24);
  return `${safeName}-${digest}`;
}

export interface McpOAuthStore {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, data: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly string[]>;
}

export function createFileMcpOAuthStore(dir: string): McpOAuthStore {
  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {
        return JSON.parse(await readFile(join(dir, key), 'utf8')) as T;
      } catch {
        return undefined;
      }
    },
    async write(key: string, data: unknown): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, key), JSON.stringify(data, null, 2), 'utf8');
    },
    async remove(key: string): Promise<void> {
      await rm(join(dir, key), { force: true });
    },
    async list(prefix?: string): Promise<readonly string[]> {
      try {
        const names = await readdir(dir);
        return prefix === undefined ? names : names.filter((name) => name.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}
