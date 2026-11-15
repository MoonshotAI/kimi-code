import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';

import { FileArtexTrafficStore } from './fileArtexTrafficStore';

export interface IArtexTrafficStoreProvider {
  readonly _serviceBrand: undefined;
  open(workspaceRoot: string): FileArtexTrafficStore;
}

export const IArtexTrafficStoreProvider = createDecorator<IArtexTrafficStoreProvider>(
  'artexTrafficStoreProvider',
);

export class ArtexTrafficStoreProvider extends Disposable implements IArtexTrafficStoreProvider {
  declare readonly _serviceBrand: undefined;

  private readonly stores = new Map<string, FileArtexTrafficStore>();

  open(workspaceRoot: string): FileArtexTrafficStore {
    const existing = this.stores.get(workspaceRoot);
    if (existing) return existing;
    const store = new FileArtexTrafficStore(workspaceRoot);
    this.stores.set(workspaceRoot, store);
    return store;
  }
}
