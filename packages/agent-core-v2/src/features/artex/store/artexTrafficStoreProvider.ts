import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';

import type { ArtexExchangeMeta } from './artexTrafficStore';
import { FileArtexTrafficStore } from './fileArtexTrafficStore';

export interface ArtexTrafficCapturedStoreEvent {
  readonly workspaceRoot: string;
  readonly exchange: ArtexExchangeMeta;
}

export interface IArtexTrafficStoreProvider {
  readonly _serviceBrand: undefined;
  readonly onDidRecord?: Event<ArtexTrafficCapturedStoreEvent>;
  open(workspaceRoot: string): FileArtexTrafficStore;
}

export const IArtexTrafficStoreProvider = createDecorator<IArtexTrafficStoreProvider>(
  'artexTrafficStoreProvider',
);

export class ArtexTrafficStoreProvider extends Disposable implements IArtexTrafficStoreProvider {
  declare readonly _serviceBrand: undefined;

  private readonly stores = new Map<string, FileArtexTrafficStore>();
  private readonly storeListeners = this._register(new DisposableStore());
  private readonly captureEmitter = this._register(new Emitter<ArtexTrafficCapturedStoreEvent>());
  readonly onDidRecord: Event<ArtexTrafficCapturedStoreEvent> = this.captureEmitter.event;

  open(workspaceRoot: string): FileArtexTrafficStore {
    const existing = this.stores.get(workspaceRoot);
    if (existing) return existing;
    const store = new FileArtexTrafficStore(workspaceRoot);
    this.storeListeners.add(
      store.onDidRecord((exchange) => {
        this.captureEmitter.fire({ workspaceRoot, exchange });
      }),
    );
    this.stores.set(workspaceRoot, store);
    return store;
  }
}
