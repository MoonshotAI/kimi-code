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

  open(workspaceRoot: string): FileArtexTrafficStore {
    return new FileArtexTrafficStore(workspaceRoot);
  }
}
