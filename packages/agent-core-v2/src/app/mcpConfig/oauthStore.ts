/**
 * `mcpConfig` domain — `IMcpOAuthStore`, the App-scope persistence
 * adapter for MCP OAuth credentials.
 *
 * Implements the `mcp` domain's `McpOAuthStore` port over the `persistence`
 * access-pattern store (`IAtomicDocumentStore`) under the `credentials/mcp`
 * scope (`<homeDir>/credentials/mcp/<key>-*.json`). One App-scope instance is
 * shared by every workspace handler's `McpOAuthService`, replacing the
 * per-handler stores they used to build ad hoc; the on-disk layout is
 * unchanged, so credentials stay shared with out-of-engine readers. The
 * {@link createMcpOAuthStore} factory remains exported for those
 * out-of-engine callers, which run an `McpOAuthService` outside the DI
 * container.
 *
 * Read semantics: missing or corrupt JSON resolves to `undefined` (never
 * throws). The provider treats `undefined` as "not stored".
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type { McpOAuthStore } from '#/mcpCore/oauth/store';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

export interface IMcpOAuthStore extends McpOAuthStore {
  readonly _serviceBrand: undefined;
}

export const IMcpOAuthStore: ServiceIdentifier<IMcpOAuthStore> =
  createDecorator<IMcpOAuthStore>('mcpOAuthStore');

const CREDENTIALS_SCOPE = 'credentials/mcp';

export function createMcpOAuthStore(docs: IAtomicDocumentStore): McpOAuthStore {
  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {
        return await docs.get<T>(CREDENTIALS_SCOPE, key);
      } catch {
        return undefined;
      }
    },
    write(key, data) {
      return docs.set(CREDENTIALS_SCOPE, key, data);
    },
    remove(key) {
      return docs.delete(CREDENTIALS_SCOPE, key);
    },
  };
}

export class McpOAuthStoreAdapter implements IMcpOAuthStore {
  declare readonly _serviceBrand: undefined;

  private readonly delegate: McpOAuthStore;

  constructor(@IAtomicDocumentStore docs: IAtomicDocumentStore) {
    this.delegate = createMcpOAuthStore(docs);
  }

  read<T>(key: string): Promise<T | undefined> {
    return this.delegate.read<T>(key);
  }

  write(key: string, data: unknown): Promise<void> {
    return this.delegate.write(key, data);
  }

  remove(key: string): Promise<void> {
    return this.delegate.remove(key);
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpOAuthStore,
  McpOAuthStoreAdapter,
  ScopeActivation.OnDemand,
  'mcpConfig',
);
