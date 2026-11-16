import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import type { ArtexFindingNode } from '#/features/artex/protocol/index';

import type { ArtexActivityEntry, IArtexGraphStore } from './artexGraphStore';
import { FileArtexGraphStore } from './fileArtexGraphStore';

export interface ArtexGraphActivityEvent {
  readonly workspaceRoot: string;
  readonly explorationId: number;
  readonly entry: ArtexActivityEntry;
}

export interface ArtexGraphFindingEvent {
  readonly workspaceRoot: string;
  readonly explorationId: number;
  readonly finding: ArtexFindingNode;
}

export interface IArtexGraphStoreProvider {
  readonly _serviceBrand: undefined;
  readonly onDidAppendActivity?: Event<ArtexGraphActivityEvent>;
  readonly onDidMutateFinding?: Event<ArtexGraphFindingEvent>;
  open(workspaceRoot: string, explorationId: number): IArtexGraphStore;
}

export const IArtexGraphStoreProvider = createDecorator<IArtexGraphStoreProvider>(
  'artexGraphStoreProvider',
);

export class ArtexGraphStoreProvider extends Disposable implements IArtexGraphStoreProvider {
  declare readonly _serviceBrand: undefined;

  private readonly stores = new Map<string, FileArtexGraphStore>();
  private readonly storeListeners = this._register(new DisposableStore());
  private readonly activityEmitter = this._register(new Emitter<ArtexGraphActivityEvent>());
  private readonly findingEmitter = this._register(new Emitter<ArtexGraphFindingEvent>());
  readonly onDidAppendActivity: Event<ArtexGraphActivityEvent> = this.activityEmitter.event;
  readonly onDidMutateFinding: Event<ArtexGraphFindingEvent> = this.findingEmitter.event;

  open(workspaceRoot: string, explorationId: number): IArtexGraphStore {
    const key = `${workspaceRoot}\0${String(explorationId)}`;
    const existing = this.stores.get(key);
    if (existing) return existing;
    const store = new FileArtexGraphStore(workspaceRoot, explorationId);
    this.storeListeners.add(
      store.onDidAppendActivity((entry) => {
        this.activityEmitter.fire({ workspaceRoot, explorationId, entry });
      }),
    );
    this.storeListeners.add(
      store.onDidMutateFinding((finding) => {
        this.findingEmitter.fire({ workspaceRoot, explorationId, finding });
      }),
    );
    this.stores.set(key, store);
    return store;
  }
}
