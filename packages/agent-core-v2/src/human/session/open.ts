import { openStore } from '#/store/node';
import type { TreeStore, Tree } from '#/store/storage';
import { isV2SessionDir, migrateV2Session } from '#/store/importers/v2';

import { SessionStores } from './stores';
import { SESSION_TREE_NAME } from './layout';

export interface OpenSessionStoreOptions {
  treeName?: string;
  fsync?: boolean;
}

export interface OpenedSessionStore {
  store: TreeStore;
  tree: Tree;
  stores: SessionStores;
  migrated: boolean;
}

export async function openSessionStore(
  dir: string,
  opts?: OpenSessionStoreOptions,
): Promise<OpenedSessionStore> {
  let migrated = false;
  if (await isV2SessionDir(dir)) {
    await migrateV2Session(dir, { treeName: opts?.treeName });
    migrated = true;
  }
  const store = await openStore(dir, { fsync: opts?.fsync ?? false });
  const tree = await store.tree(opts?.treeName ?? SESSION_TREE_NAME);
  return { store, tree, stores: new SessionStores(tree), migrated };
}
