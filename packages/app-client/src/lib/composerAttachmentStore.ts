import {
  ensureAttachmentMediaOrdinal,
  normalizeAttachmentMediaOrdinals,
  type AttachmentEntry,
} from '@moonshot-ai/app-composer/features/attachment';
import { onStashedStateDropped } from '@moonshot-ai/app-composer/runtime';

interface StoredAttachmentAsset {
  entry: AttachmentEntry;
  source?: Blob;
  uploadAbort?: AbortController;
  generation: number;
}

type AttachmentStoreListener = (entries: readonly AttachmentEntry[]) => void;

const MAX_INACTIVE_SOURCE_COUNT = 20;
const MAX_INACTIVE_SOURCE_BYTES = 256 * 1024 * 1024;

function disposeAsset(asset: StoredAttachmentAsset): void {
  asset.uploadAbort?.abort();
  if (asset.entry.previewUrl !== undefined) URL.revokeObjectURL(asset.entry.previewUrl);
}

export class ComposerAttachmentStore {
  private readonly assetsByScope = new Map<string, Map<string, StoredAttachmentAsset>>();
  private readonly listenersByScope = new Map<string, Set<AttachmentStoreListener>>();

  private assets(scope: string): Map<string, StoredAttachmentAsset> {
    let assets = this.assetsByScope.get(scope);
    if (assets === undefined) {
      assets = new Map();
      this.assetsByScope.set(scope, assets);
    }
    return assets;
  }

  private emit(scope: string): void {
    const entries = this.entries(scope);
    for (const listener of this.listenersByScope.get(scope) ?? []) listener(entries);
  }

  entries(scope: string): AttachmentEntry[] {
    return [...(this.assetsByScope.get(scope)?.values() ?? [])].map((asset) => asset.entry);
  }

  entry(scope: string, attId: string): AttachmentEntry | undefined {
    return this.assetsByScope.get(scope)?.get(attId)?.entry;
  }

  source(scope: string, attId: string): Blob | undefined {
    return this.assetsByScope.get(scope)?.get(attId)?.source;
  }

  restore(scope: string, readDraft: () => readonly AttachmentEntry[]): void {
    if (this.entries(scope).length === 0) this.load(scope, readDraft());
  }

  load(scope: string, entries: readonly AttachmentEntry[]): void {
    const assets = this.assets(scope);
    const normalized = normalizeAttachmentMediaOrdinals(entries);
    const incoming = new Set(normalized.map((entry) => entry.attId));
    for (const [attId, asset] of assets) {
      if (incoming.has(attId)) continue;
      disposeAsset(asset);
      assets.delete(attId);
    }
    for (const entry of normalized) {
      let current = assets.get(entry.attId);
      if (current !== undefined && current.entry.key !== entry.key) {
        disposeAsset(current);
        current = undefined;
      }
      const nextEntry =
        entry.previewUrl === undefined && current?.entry.previewUrl !== undefined
          ? { ...entry, previewUrl: current.entry.previewUrl }
          : entry;
      assets.set(entry.attId, {
        entry: { ...nextEntry, remoteSource: nextEntry.remoteSource ?? (current?.entry.key === entry.key ? current.entry.remoteSource : undefined) },
        source: current?.source,
        uploadAbort: current?.uploadAbort,
        generation: current?.generation ?? 0,
      });
    }
    this.emit(scope);
  }

  sync(scope: string, entries: readonly AttachmentEntry[]): void {
    const assets = this.assets(scope);
    for (const entry of normalizeAttachmentMediaOrdinals(entries)) {
      const current = assets.get(entry.attId);
      assets.set(entry.attId, {
        entry: { ...entry, remoteSource: entry.remoteSource ?? (current?.entry.key === entry.key ? current.entry.remoteSource : undefined) },
        source: current?.source,
        uploadAbort: current?.uploadAbort,
        generation: current?.generation ?? 0,
      });
    }
    this.emit(scope);
  }

  upsert(scope: string, entry: AttachmentEntry, source?: Blob): void {
    const assets = this.assets(scope);
    const current = assets.get(entry.attId);
    const normalized = ensureAttachmentMediaOrdinal(
      entry.mediaOrdinal === undefined && current?.entry.mediaOrdinal !== undefined
        ? { ...entry, mediaOrdinal: current.entry.mediaOrdinal }
        : entry,
      [...assets.values()].map((asset) => asset.entry),
    );
    if (current?.entry.previewUrl !== undefined && current.entry.previewUrl !== normalized.previewUrl) {
      URL.revokeObjectURL(current.entry.previewUrl);
    }
    assets.set(entry.attId, {
      entry: { ...normalized, remoteSource: normalized.remoteSource ?? (current?.entry.key === entry.key ? current.entry.remoteSource : undefined) },
      source: source ?? current?.source,
      uploadAbort: current?.uploadAbort,
      generation: current?.generation ?? 0,
    });
    this.emit(scope);
  }

  patch(
    scope: string,
    attId: string,
    patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>,
  ): AttachmentEntry | undefined {
    const asset = this.assetsByScope.get(scope)?.get(attId);
    if (asset === undefined) return undefined;
    if (
      'previewUrl' in patch &&
      asset.entry.previewUrl !== undefined &&
      asset.entry.previewUrl !== patch.previewUrl
    ) {
      URL.revokeObjectURL(asset.entry.previewUrl);
    }
    asset.entry = { ...asset.entry, ...patch };
    this.emit(scope);
    return asset.entry;
  }

  setSource(scope: string, attId: string, source: Blob | undefined): void {
    const asset = this.assetsByScope.get(scope)?.get(attId);
    if (asset === undefined) return;
    asset.source = source;
  }

  remoteSource(scope: string, attId: string): { sessionId: string; fileId: string } | undefined {
    return this.assetsByScope.get(scope)?.get(attId)?.entry.remoteSource;
  }

  setRemoteSource(scope: string, attId: string, source: { sessionId: string; fileId: string }): void {
    this.patch(scope, attId, { remoteSource: { ...source } });
  }

  beginUpload(scope: string, attId: string): { generation: number; signal: AbortSignal } | null {
    const asset = this.assetsByScope.get(scope)?.get(attId);
    if (asset === undefined) return null;
    asset.uploadAbort?.abort();
    asset.generation += 1;
    asset.uploadAbort = new AbortController();
    return { generation: asset.generation, signal: asset.uploadAbort.signal };
  }

  uploadIsCurrent(scope: string, attId: string, generation: number): boolean {
    const asset = this.assetsByScope.get(scope)?.get(attId);
    return asset !== undefined && asset.generation === generation && asset.uploadAbort?.signal.aborted !== true;
  }

  uploadRunning(scope: string, attId: string): boolean {
    const asset = this.assetsByScope.get(scope)?.get(attId);
    return asset?.uploadAbort !== undefined && asset.uploadAbort.signal.aborted !== true;
  }

  settleUpload(scope: string, attId: string, generation: number): void {
    const asset = this.assetsByScope.get(scope)?.get(attId);
    if (asset === undefined || asset.generation !== generation) return;
    asset.uploadAbort = undefined;
    if (asset.entry.fileId !== undefined) asset.source = undefined;
  }

  abortUpload(scope: string, attId: string): void {
    const asset = this.assetsByScope.get(scope)?.get(attId);
    if (asset === undefined) return;
    asset.uploadAbort?.abort();
    asset.uploadAbort = undefined;
    asset.generation += 1;
  }

  releaseInactiveResources(
    scope: string,
    activeIds: ReadonlySet<string>,
    maxSourceCount = MAX_INACTIVE_SOURCE_COUNT,
    maxSourceBytes = MAX_INACTIVE_SOURCE_BYTES,
  ): void {
    const assets = this.assetsByScope.get(scope);
    if (assets === undefined) return;
    let changed = false;
    for (const [attId, asset] of assets) {
      if (activeIds.has(attId) || asset.entry.fileId === undefined) continue;
      if (asset.entry.previewUrl !== undefined) {
        URL.revokeObjectURL(asset.entry.previewUrl);
        asset.entry = { ...asset.entry, previewUrl: undefined };
        changed = true;
      }
      if (asset.source !== undefined) {
        asset.source = undefined;
        changed = true;
      }
    }
    const retained = [...assets].filter(([attId, asset]) =>
      !activeIds.has(attId) &&
      asset.entry.fileId === undefined &&
      (asset.source !== undefined || asset.entry.previewUrl !== undefined || asset.entry.thumbnailUrl !== undefined),
    );
    let retainedBytes = retained.reduce(
      (total, [, asset]) => total + (asset.source?.size ?? asset.entry.size ?? 0),
      0,
    );
    while (retained.length > maxSourceCount || retainedBytes > maxSourceBytes) {
      const oldest = retained.shift();
      if (oldest === undefined) break;
      const [, asset] = oldest;
      retainedBytes -= asset.source?.size ?? asset.entry.size ?? 0;
      asset.uploadAbort?.abort();
      asset.uploadAbort = undefined;
      asset.generation += 1;
      asset.source = undefined;
      if (asset.entry.previewUrl !== undefined) URL.revokeObjectURL(asset.entry.previewUrl);
      asset.entry = {
        ...asset.entry,
        previewUrl: undefined,
        thumbnailUrl: undefined,
        uploadProgress: undefined,
        uploading: false,
        error: asset.entry.error ?? 'upload-interrupted',
      };
      changed = true;
    }
    if (changed) this.emit(scope);
  }

  remove(scope: string, attId: string): void {
    const assets = this.assetsByScope.get(scope);
    const asset = assets?.get(attId);
    if (asset === undefined) return;
    disposeAsset(asset);
    assets!.delete(attId);
    if (assets!.size === 0) this.assetsByScope.delete(scope);
    this.emit(scope);
  }

  clear(scope: string): void {
    const assets = this.assetsByScope.get(scope);
    if (assets !== undefined) {
      for (const asset of assets.values()) disposeAsset(asset);
      this.assetsByScope.delete(scope);
    }
    this.emit(scope);
  }

  subscribe(scope: string, listener: AttachmentStoreListener): () => void {
    let listeners = this.listenersByScope.get(scope);
    if (listeners === undefined) {
      listeners = new Set();
      this.listenersByScope.set(scope, listeners);
    }
    listeners.add(listener);
    listener(this.entries(scope));
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.listenersByScope.delete(scope);
    };
  }
}

export const composerAttachmentStore = new ComposerAttachmentStore();

onStashedStateDropped((sessionId) => composerAttachmentStore.clear(sessionId));
