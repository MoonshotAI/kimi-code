import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';

import type { IArtexGraphStore } from './artexGraphStore';
import { FileArtexGraphStore } from './fileArtexGraphStore';

export interface IArtexGraphStoreProvider {
  readonly _serviceBrand: undefined;
  open(workspaceRoot: string, explorationId: number): IArtexGraphStore;
}

export const IArtexGraphStoreProvider = createDecorator<IArtexGraphStoreProvider>(
  'artexGraphStoreProvider',
);

export class ArtexGraphStoreProvider extends Disposable implements IArtexGraphStoreProvider {
  declare readonly _serviceBrand: undefined;

  open(workspaceRoot: string, explorationId: number): IArtexGraphStore {
    return new FileArtexGraphStore(workspaceRoot, explorationId);
  }
}
