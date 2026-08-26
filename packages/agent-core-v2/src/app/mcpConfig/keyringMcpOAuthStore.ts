import type { KeyringApi } from '@moonshot-ai/kimi-code-oauth';

import type { ILogger } from '#/_base/log/log';
import type { McpOAuthStore } from '#/mcpCore/oauth/store';

export const KEYRING_MCP_OAUTH_SERVICE = 'kimi-code-mcp';

let degraded = false;

export function createKeyringMcpOAuthStore(
  api: KeyringApi,
  fallback: McpOAuthStore,
  log?: ILogger,
): McpOAuthStore {
  degraded = false;

  const degrade = (operation: 'read' | 'write' | 'remove' | 'list', error: unknown): void => {
    if (degraded) return;
    degraded = true;
    log?.warn(
      `MCP OAuth keyring store ${operation} failed; using the document store for the rest of this process`,
      { error: error instanceof Error ? error.message : String(error) },
    );
  };

  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  return {
    async read<T>(key: string): Promise<T | undefined> {
      if (!degraded) {
        try {
          const raw = api.createEntry(KEYRING_MCP_OAUTH_SERVICE, key).getPassword();
          const parsed = raw === null ? undefined : parse(raw);
          if (parsed !== undefined) return parsed as T;
        } catch (error) {
          degrade('read', error);
        }
      }
      return fallback.read<T>(key);
    },
    async write(key: string, data: unknown): Promise<void> {
      if (!degraded) {
        try {
          api.createEntry(KEYRING_MCP_OAUTH_SERVICE, key).setPassword(JSON.stringify(data));
        } catch (error) {
          degrade('write', error);
          await fallback.write(key, data);
          return;
        }
        await fallback.remove(key);
        return;
      }
      await fallback.write(key, data);
    },
    async remove(key: string): Promise<void> {
      if (!degraded) {
        try {
          api.createEntry(KEYRING_MCP_OAUTH_SERVICE, key).deleteCredential();
        } catch (error) {
          degrade('remove', error);
        }
      }
      await fallback.remove(key);
    },
    async list(prefix?: string): Promise<readonly string[]> {
      if (!degraded) {
        try {
          const accounts = api.findAccounts(KEYRING_MCP_OAUTH_SERVICE);
          const fromFallback = await fallback.list(prefix);
          const merged = [...new Set([...accounts, ...fromFallback])];
          return prefix === undefined ? merged : merged.filter((key) => key.startsWith(prefix));
        } catch (error) {
          degrade('list', error);
        }
      }
      return fallback.list(prefix);
    },
  };
}
