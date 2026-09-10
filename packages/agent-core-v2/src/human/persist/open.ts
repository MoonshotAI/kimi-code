import { NodeBackend } from '#/store/backend/node';
import { TreeStore } from '#/store/store';
import type { Tree } from '#/store/tree';

import { SessionStores } from '#/session/stores';

import { isV2SessionDir, migrateV2Session, V2_SESSION_TREE_NAME } from './v2/migrate';

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
    await migrateV2Session(dir);
    migrated = true;
  }
  const backend = new NodeBackend(dir);
  const store = await TreeStore.open(backend, { fsync: opts?.fsync ?? false });
  const tree = await store.tree(opts?.treeName ?? V2_SESSION_TREE_NAME);
  return { store, tree, stores: new SessionStores(tree, backend), migrated };
}
