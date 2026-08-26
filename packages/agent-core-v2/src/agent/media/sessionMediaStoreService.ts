import { extname } from 'node:path';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { isFileId } from '#/app/file/fileService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  AUDIO_MIME_BY_SUFFIX,
  IMAGE_MIME_BY_SUFFIX,
  mediaExtensionForMime,
  VIDEO_MIME_BY_SUFFIX,
} from './mediaRef';
import {
  ISessionMediaStore,
  type SessionMediaFile,
  type SessionMediaMaterializeInput,
} from './sessionMediaStore';

interface SessionMediaMetadata {
  readonly version: 1;
  readonly key: string;
  readonly name: string;
  readonly mediaType: string;
}

export class SessionMediaStoreService implements ISessionMediaStore {
  declare readonly _serviceBrand: undefined;
  private readonly scope: string;

  constructor(
    @ISessionContext sessionContext: ISessionContext,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    this.scope = sessionContext.scope('media');
  }

  pathFor(fileId: string, ext: string): string | undefined {
    if (!isFileId(fileId)) return undefined;
    return this.storage.pathFor(this.scope, this.keyFor(fileId, ext));
  }

  async resolveDisplayPath(fileId: string): Promise<string | undefined> {
    if (!isFileId(fileId)) return undefined;
    const key = await this.findKey(fileId);
    if (key === undefined) return undefined;
    return this.storage.pathFor(this.scope, key);
  }

  async read(
    fileId: string,
  ): Promise<{ readonly data: Uint8Array; readonly name: string } | undefined> {
    if (!isFileId(fileId)) return undefined;
    const stored = await this.resolveStored(fileId);
    if (stored === undefined) return undefined;
    const data = await this.storage.read(this.scope, stored.key);
    if (data === undefined) return undefined;
    const name =
      stored.metadata !== undefined && extname(stored.metadata.name) !== ''
        ? stored.metadata.name
        : stored.key;
    return { data, name };
  }

  async open(fileId: string): Promise<SessionMediaFile | undefined> {
    if (!isFileId(fileId)) return undefined;
    const stored = await this.resolveStored(fileId);
    if (stored === undefined) return undefined;
    const size = await this.storage.size(this.scope, stored.key);
    if (size === undefined) return undefined;
    return {
      path: this.storage.pathFor(this.scope, stored.key),
      name: stored.metadata?.name ?? stored.key,
      mediaType: stored.metadata?.mediaType ?? this.mediaTypeForKey(stored.key),
      size,
      stream: (range) => this.storage.readStream(this.scope, stored.key, range),
    };
  }

  async materialize(input: SessionMediaMaterializeInput): Promise<string | undefined> {
    if (!isFileId(input.fileId)) return undefined;
    const ext = extname(input.name) || (mediaExtensionForMime(input.mimeType) ?? '.bin');
    const key = this.keyFor(input.fileId, ext);
    let wroteCanonical = false;
    try {
      const existingSize = await this.storage.size(this.scope, key);
      input.signal?.throwIfAborted();
      if (existingSize !== input.size) {
        const source = input.stream() as NodeJS.ReadableStream & AsyncIterable<Uint8Array>;
        await this.storage.writeStream(this.scope, key, source, {
          atomic: true,
          signal: input.signal,
        });
        wroteCanonical = true;
      }
      input.signal?.throwIfAborted();
      await this.documents.set(this.scope, this.metadataKey(input.fileId), {
        version: 1,
        key,
        name: input.name,
        mediaType: input.mimeType,
      });
    } catch (error) {
      if (wroteCanonical) await this.storage.delete(this.scope, key).catch(() => undefined);
      throw error;
    }
    return this.storage.pathFor(this.scope, key);
  }

  private async resolveStored(
    fileId: string,
  ): Promise<{ readonly key: string; readonly metadata: SessionMediaMetadata | undefined } | undefined> {
    const storedMetadata = await this.documents
      .get<unknown>(this.scope, this.metadataKey(fileId))
      .catch(() => undefined);
    const metadata = this.isMetadataFor(storedMetadata, fileId) ? storedMetadata : undefined;
    const key =
      metadata !== undefined && (await this.storage.size(this.scope, metadata.key)) !== undefined
        ? metadata.key
        : await this.findKey(fileId);
    return key === undefined ? undefined : { key, metadata };
  }

  private keyFor(fileId: string, ext: string): string {
    return `${fileId}${ext}`;
  }

  private metadataKey(fileId: string): string {
    return `meta/${fileId}.json`;
  }

  private isMetadataFor(value: unknown, fileId: string): value is SessionMediaMetadata {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<SessionMediaMetadata>;
    return (
      candidate.version === 1 &&
      typeof candidate.key === 'string' &&
      (candidate.key === fileId || candidate.key.startsWith(`${fileId}.`)) &&
      !candidate.key.includes('/') &&
      !candidate.key.includes('\\') &&
      typeof candidate.name === 'string' &&
      candidate.name.length > 0 &&
      typeof candidate.mediaType === 'string' &&
      candidate.mediaType.length > 0
    );
  }

  private mediaTypeForKey(key: string): string {
    const ext = extname(key).toLowerCase();
    return (
      IMAGE_MIME_BY_SUFFIX[ext] ??
      VIDEO_MIME_BY_SUFFIX[ext] ??
      AUDIO_MIME_BY_SUFFIX[ext] ??
      'application/octet-stream'
    );
  }

  private async findKey(fileId: string): Promise<string | undefined> {
    const keys = await this.storage.list(this.scope, fileId);
    return keys.find(
      (key) =>
        key === fileId || (key.startsWith(`${fileId}.`) && !key.includes('.tmp.')),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMediaStore,
  SessionMediaStoreService,
  ScopeActivation.OnScopeCreated,
  'media',
);
