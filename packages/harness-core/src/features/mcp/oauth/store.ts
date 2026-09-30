import { basename, join } from 'pathe';

import { sha256Hex } from '#/sha256';
import type { OsFsPort } from '#/features/os/host/index';

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
  const digest = sha256Hex(`${serverName}\0${resource}`).slice(0, 24);
  return `${safeName}-${digest}`;
}

export interface McpOAuthStore {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, data: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly string[]>;
}

export function createFileMcpOAuthStore(dir: string, fs: OsFsPort): McpOAuthStore {
  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {
        return JSON.parse(await fs.readText(join(dir, key))) as T;
      } catch {
        return undefined;
      }
    },
    async write(key: string, data: unknown): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeText(join(dir, key), JSON.stringify(data, null, 2));
    },
    async remove(key: string): Promise<void> {
      await fs.remove(join(dir, key)).catch(() => {});
    },
    async list(prefix?: string): Promise<readonly string[]> {
      try {
        const names = (await fs.readdir(dir)).map((entry) => entry.name);
        return prefix === undefined ? names : names.filter((name) => name.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}

export function createMemoryMcpOAuthStore(): McpOAuthStore {
  const map = new Map<string, unknown>();
  return {
    read: async <T>(key: string) => map.get(key) as T | undefined,
    write: async (key: string, data: unknown) => {
      map.set(key, data);
    },
    remove: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix?: string) =>
      [...map.keys()].filter((name) => prefix === undefined || name.startsWith(prefix)),
  };
}
