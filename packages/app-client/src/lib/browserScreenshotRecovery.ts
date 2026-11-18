import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { ComposerAttachmentStore } from './composerAttachmentStore';

export interface BrowserScreenshotAsset {
  data: string;
  mimeType: string;
  name: string;
  size: number;
}

export function browserScreenshotFile(asset: BrowserScreenshotAsset): File {
  if (asset.mimeType !== 'image/png' || asset.data.length > 14 * 1024 * 1024) throw new Error('Invalid browser screenshot');
  const binary = atob(asset.data);
  if (binary.length !== asset.size || binary.length === 0 || binary.length > 10 * 1024 * 1024) throw new Error('Invalid browser screenshot size');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], asset.name, { type: asset.mimeType });
}

export interface BrowserScreenshotSources {
  readAsset?: (id: string) => Promise<BrowserScreenshotAsset>;
  readRemote?: (source: { sessionId: string; fileId: string }, signal: AbortSignal) => Promise<Blob>;
}

export class BrowserScreenshotRecovery {
  private readonly attempted = new Set<string>();

  constructor(private readonly store: ComposerAttachmentStore) {}

  resetAttempts(): void {
    this.attempted.clear();
  }

  canRecover(scope: string, attId: string, sources: BrowserScreenshotSources): boolean {
    const entry = this.store.entry(scope, attId);
    return entry?.purpose === 'browser-screenshot' && entry.kind === 'image' && (
      this.store.source(scope, attId) !== undefined ||
      (sources.readRemote !== undefined && this.store.remoteSource(scope, attId) !== undefined) ||
      (sources.readAsset !== undefined && entry.browserAssetId !== undefined)
    );
  }

  async recover(options: BrowserScreenshotSources & {
    scope: string;
    attId: string;
    patch: (patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>) => void;
    upload: (blob: Blob, name: string) => void;
    retry?: boolean;
  }): Promise<boolean> {
    const { scope, attId } = options;
    const entry = this.store.entry(scope, attId);
    if (entry?.purpose !== 'browser-screenshot' || entry.kind !== 'image' || (entry.fileId !== undefined && (!options.retry || entry.error === undefined)) || this.store.uploadRunning(scope, attId)) return false;
    const existing = this.store.source(scope, attId);
    if (!this.canRecover(scope, attId, options)) return false;
    const remote = this.store.remoteSource(scope, attId);
    const attemptKey = JSON.stringify([scope, attId, entry.key, entry.browserAssetId, remote]);
    if (!options.retry && this.attempted.has(attemptKey)) return false;
    const task = this.store.beginUpload(scope, attId);
    if (task === null) return false;
    const isCurrent = (): boolean => {
      const current = this.store.entry(scope, attId);
      return !task.signal.aborted && this.store.uploadIsCurrent(scope, attId, task.generation) && current?.key === entry.key && current.browserAssetId === entry.browserAssetId;
    };
    try {
      options.patch({ uploading: true, uploadProgress: undefined, error: undefined });
      let blob = existing;
      const loaders: Array<() => Promise<Blob>> = [];
      if (remote !== undefined && options.readRemote !== undefined) loaders.push(() => options.readRemote!(remote, task.signal));
      if (entry.browserAssetId !== undefined && options.readAsset !== undefined) loaders.push(async () => browserScreenshotFile(await options.readAsset!(entry.browserAssetId!)));
      for (const load of loaders) {
        if (blob !== undefined || !isCurrent()) break;
        try { blob = await load(); } catch { continue; }
      }
      if (blob === undefined) throw new Error('Browser screenshot source is unavailable');
      if (!isCurrent()) return false;
      this.store.setSource(scope, attId, blob);
      options.patch({ previewUrl: URL.createObjectURL(blob), mediaType: blob.type, size: blob.size, fileId: undefined, sessionId: undefined });
      if (!isCurrent()) return false;
      options.upload(blob, entry.name);
      this.attempted.add(attemptKey);
      return true;
    } catch {
      if (isCurrent()) {
        this.attempted.add(attemptKey);
        options.patch({ uploading: false, uploadProgress: undefined, error: 'upload-interrupted' });
      }
      return false;
    } finally {
      if (isCurrent()) this.store.settleUpload(scope, attId, task.generation);
    }
  }
}
