import { NodeBackend } from './internal/storage/backend/node';
import { TreeStore, type TreeStoreOptions } from './storage';

export { NodeBackend };

export function openStore(dir: string, options?: TreeStoreOptions): Promise<TreeStore> {
  return TreeStore.open(new NodeBackend(dir), options);
}
