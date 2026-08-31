import {
  KEYRING_SERVICE,
  keyringServiceForCredentialsDir,
  type KeyringApi,
  withFileLock,
} from '@moonshot-ai/kimi-code-oauth';
import { createHash } from 'node:crypto';
import { join } from 'pathe';

import type { ILogger } from '#/_base/log/log';
import type { McpOAuthStore } from '#/mcpCore/oauth/store';

export const KEYRING_MCP_OAUTH_SERVICE = 'kimi-code-mcp';

export function keyringMcpOAuthServiceForCredentialsDir(credentialsDir: string): string {
  const base = keyringServiceForCredentialsDir(credentialsDir);
  return base === KEYRING_SERVICE ? KEYRING_MCP_OAUTH_SERVICE : `${base}-mcp`;
}

export function keyringMcpOAuthLockTarget(credentialsDir: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return join(credentialsDir, 'mcp', `.keyring-${digest}.lock-target`);
}

export function createKeyringMcpOAuthStore(
  api: KeyringApi,
  fallback: McpOAuthStore,
  log?: ILogger,
  service = KEYRING_MCP_OAUTH_SERVICE,
  lockTarget?: (key: string) => string,
  legacyService?: string,
): McpOAuthStore {
  const previousService =
    legacyService ??
    (service === KEYRING_MCP_OAUTH_SERVICE ? undefined : KEYRING_MCP_OAUTH_SERVICE);
  let degraded = false;
  let degradationError: unknown;
  const queues = new Map<string, Promise<void>>();

  async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(key);
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(key, next);
    if (previous !== undefined) await previous;
    try {
      return lockTarget === undefined ? await fn() : await withFileLock(lockTarget(key), fn);
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  }

  const degrade = (operation: 'read' | 'write' | 'remove' | 'list', error: unknown): void => {
    if (degraded) return;
    degraded = true;
    degradationError = error;
    log?.warn(
      `MCP OAuth keyring store ${operation} failed; using the document store for this store`,
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
      return exclusive(key, async () => {
        if (!degraded) {
          try {
            let sourceService = service;
            let raw = api.createEntry(service, key).getPassword();
            if (raw === null && previousService !== undefined) {
              raw = api.createEntry(previousService, key).getPassword();
              sourceService = previousService;
            }
            const parsed = raw === null ? undefined : parse(raw);
            if (parsed !== undefined) {
              let value = parsed as T;
              if (key.endsWith('-tokens.json') && isStoredToken(parsed)) {
                const fallbackValue = await fallback.read<T>(key);
                const newer = newerTokenGrant(parsed, fallbackValue);
                if (newer !== undefined) {
                  api.createEntry(service, key).setPassword(JSON.stringify(newer));
                  await fallback.remove(key);
                  value = newer;
                }
              }
              if (sourceService !== service) {
                api.createEntry(service, key).setPassword(JSON.stringify(value));
                try {
                  removeKeyringEntry(api, sourceService, key);
                } catch (error) {
                  log?.warn(`MCP OAuth legacy keyring cleanup failed for ${key}`, {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              return value;
            }
          } catch (error) {
            degrade('read', error);
          }
        }
        const value = await fallback.read<T>(key);
        if (value === undefined && degradationError !== undefined) {
          throw new Error(`keyring unavailable while reading MCP OAuth credential "${key}"`, {
            cause: degradationError,
          });
        }
        if (value === undefined || degraded) return value;
        try {
          api.createEntry(service, key).setPassword(JSON.stringify(value));
        } catch (error) {
          degrade('write', error);
          return value;
        }
        await fallback.remove(key);
        return value;
      });
    },
    async write(key: string, data: unknown): Promise<void> {
      await exclusive(key, async () => {
        if (!degraded) {
          try {
            api.createEntry(service, key).setPassword(JSON.stringify(data));
          } catch (error) {
            degrade('write', error);
            await fallback.write(key, data);
            return;
          }
          if (previousService !== undefined && previousService !== service) {
            try {
              removeKeyringEntry(api, previousService, key);
            } catch (error) {
              log?.warn(`MCP OAuth legacy keyring cleanup failed for ${key}`, {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          await fallback.remove(key);
          return;
        }
        await fallback.write(key, data);
      });
    },
    async remove(key: string): Promise<void> {
      await exclusive(key, async () => {
        let keyringError: unknown;
        try {
          removeKeyringEntry(api, service, key);
          if (previousService !== undefined && previousService !== service) {
            removeKeyringEntry(api, previousService, key);
          }
        } catch (error) {
          keyringError = error;
          degrade('remove', error);
        }
        await fallback.remove(key);
        if (keyringError !== undefined) {
          throw new Error(`failed to remove MCP OAuth credential "${key}"`, {
            cause: keyringError,
          });
        }
      });
    },
    async list(prefix?: string): Promise<readonly string[]> {
      if (!degraded) {
        try {
          const accounts = [
            ...api.findAccounts(service),
            ...(previousService === undefined ? [] : api.findAccounts(previousService)),
          ];
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

function removeKeyringEntry(api: KeyringApi, service: string, key: string): void {
  const deleted = api.createEntry(service, key).deleteCredential();
  if (!deleted && api.findAccounts(service).includes(key)) {
    throw new Error(`failed to delete keyring MCP OAuth credential "${key}"`);
  }
}

function newerTokenGrant<T>(keyringValue: unknown, fallbackValue: T | undefined): T | undefined {
  if (!isStoredToken(keyringValue) || !isStoredToken(fallbackValue)) return undefined;
  return fallbackValue.obtained_at > keyringValue.obtained_at ? fallbackValue : undefined;
}

function isStoredToken(value: unknown): value is { readonly obtained_at: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { obtained_at?: unknown }).obtained_at === 'number' &&
    Number.isFinite((value as { obtained_at: number }).obtained_at)
  );
}
