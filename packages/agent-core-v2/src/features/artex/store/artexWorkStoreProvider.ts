import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';

import type { IArtexWorkStore } from './artexWorkStore';
import { FileArtexWorkStore } from './fileArtexWorkStore';

export interface IArtexWorkStoreProvider {
  readonly _serviceBrand: undefined;
  open(workspaceRoot: string): IArtexWorkStore;
}

export const IArtexWorkStoreProvider = createDecorator<IArtexWorkStoreProvider>(
  'artexWorkStoreProvider',
);

export class ArtexWorkStoreProvider extends Disposable implements IArtexWorkStoreProvider {
  declare readonly _serviceBrand: undefined;

  private readonly stores = new Map<string, IArtexWorkStore>();

  open(workspaceRoot: string): IArtexWorkStore {
    const existing = this.stores.get(workspaceRoot);
    if (existing) return existing;
    const store = new FileArtexWorkStore(workspaceRoot);
    this.stores.set(workspaceRoot, store);
    return store;
  }
}
