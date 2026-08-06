/**
 * `media` domain — `ISessionMediaStore` implementation.
 *
 * Materializes and reads session-canonical media through the `storage` byte
 * backend, addressed by `sessionContext`, with the shared cache as a fallback
 * when the session media directory is unavailable. Filesystem deployments
 * expose an absolute host path for model readback; non-filesystem deployments
 * retain the canonical bytes without inventing one. Every entry point rejects
 * ids that are not minted upload ids (`isFileId`) — the id becomes a storage
 * key here, so an unvalidated id would be a path-traversal vector. Bound at
 * Session scope.
 */

import { extname } from 'node:path';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { isFileId } from '#/app/file/fileService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { mediaExtensionForMime } from './mediaRef';
import { ISessionMediaStore, type SessionMediaMaterializeInput } from './sessionMediaStore';

export class SessionMediaStoreService implements ISessionMediaStore {
  declare readonly _serviceBrand: undefined;
  private readonly scope: string;
  private readonly fallbackScope: string;

  constructor(
    @ISessionContext sessionContext: ISessionContext,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    this.scope = sessionContext.scope('media');
    this.fallbackScope = bootstrap.scope('cache');
  }

  pathFor(fileId: string, ext: string): string | undefined {
    if (!isFileId(fileId)) return undefined;
    return this.storage.pathFor(this.scope, this.keyFor(fileId, ext));
  }

  async resolveDisplayPath(fileId: string, hint: string | undefined): Promise<string | undefined> {
    if (hint === undefined || hint.length === 0) return undefined;
    // An id that is not a minted upload id can never have a canonical copy —
    // and must never become a storage key (path traversal guard). Treat it
    // like a missing copy: the caller's own hint stands.
    if (!isFileId(fileId)) return hint;
    const ext = extname(hint);
    const canonical = this.pathFor(fileId, ext);
    if (canonical === undefined || canonical === hint) return hint;
    const size = await this.storage.size(this.scope, this.keyFor(fileId, ext));
    return size === undefined ? hint : canonical;
  }

  async read(
    fileId: string,
    hintPath?: string,
  ): Promise<{ readonly data: Uint8Array; readonly name: string } | undefined> {
    if (!isFileId(fileId)) return undefined;
    const key = await this.findKey(fileId, hintPath);
    if (key === undefined) return undefined;
    const data = await this.storage.read(this.scope, key);
    return data === undefined ? undefined : { data, name: key };
  }

  async materialize(input: SessionMediaMaterializeInput): Promise<string | undefined> {
    return this.materializeAt(this.scope, input);
  }

  async materializeFallback(input: SessionMediaMaterializeInput): Promise<string | undefined> {
    return this.materializeAt(this.fallbackScope, input);
  }

  private async materializeAt(
    scope: string,
    input: SessionMediaMaterializeInput,
  ): Promise<string | undefined> {
    if (!isFileId(input.fileId)) return undefined;
    const ext =
      (input.hintPath === undefined ? '' : extname(input.hintPath)) ||
      extname(input.name) ||
      mediaExtensionForMime(input.mimeType) ||
      '.bin';
    const key = this.keyFor(input.fileId, ext);
    const existingSize = await this.storage.size(scope, key);
    if (existingSize !== input.size) {
      const source = input.stream() as NodeJS.ReadableStream & AsyncIterable<Uint8Array>;
      await this.storage.writeStream(scope, key, source, {
        atomic: true,
        signal: input.signal,
      });
    }
    return this.storage.pathFor(scope, key);
  }

  private keyFor(fileId: string, ext: string): string {
    return `${fileId}${ext}`;
  }

  private async findKey(fileId: string, hintPath: string | undefined): Promise<string | undefined> {
    if (hintPath !== undefined) {
      const hinted = this.keyFor(fileId, extname(hintPath));
      if ((await this.storage.size(this.scope, hinted)) !== undefined) return hinted;
    }
    const keys = await this.storage.list(this.scope, fileId);
    return keys.find((key) => key === fileId || key.startsWith(`${fileId}.`));
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMediaStore,
  SessionMediaStoreService,
  ScopeActivation.OnScopeCreated,
  'media',
);
