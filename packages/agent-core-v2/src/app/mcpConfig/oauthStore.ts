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
    list(prefix) {
      return docs.list(CREDENTIALS_SCOPE, prefix);
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

  list(prefix?: string): Promise<readonly string[]> {
    return this.delegate.list(prefix);
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpOAuthStore,
  McpOAuthStoreAdapter,
  ScopeActivation.OnDemand,
  'mcpConfig',
);
