/**
 * `media` domain — `ISessionMediaStore` implementation.
 *
 * The one place the media domain touches the host filesystem for the
 * session's `media/` dir (node:fs is confined here, as in the persistence
 * backends): materialization writes to a unique tmp sibling and atomically
 * renames it into place, so a concurrent or crashed writer can never leave a
 * partial canonical file, and a same-size existing copy is reused. Reads
 * (`resolveDisplayPath`) trust the canonical location only when it exists.
 * Bound at Session scope.
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { mediaExtensionForMime, sessionMediaFilePath } from './mediaRef';
import { ISessionMediaStore } from './sessionMediaStore';

export class SessionMediaStoreService implements ISessionMediaStore {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionContext private readonly sessionContext: ISessionContext) {}

  pathFor(fileId: string, ext: string): string {
    return sessionMediaFilePath(this.sessionContext.sessionDir, fileId, ext);
  }

  async resolveDisplayPath(fileId: string, hint: string | undefined): Promise<string | undefined> {
    if (hint === undefined || hint.length === 0) return undefined;
    const canonical = this.pathFor(fileId, extname(hint));
    if (canonical === hint) return hint;
    const own = await stat(canonical).catch(() => undefined);
    return own === undefined ? hint : canonical;
  }

  async materialize(input: {
    readonly fileId: string;
    readonly size: number;
    readonly name: string;
    readonly mimeType: string;
    readonly hintPath?: string;
    readonly stream: () => NodeJS.ReadableStream;
  }): Promise<string> {
    const ext =
      (input.hintPath === undefined ? '' : extname(input.hintPath)) ||
      extname(input.name) ||
      mediaExtensionForMime(input.mimeType) ||
      '.bin';
    const target = this.pathFor(input.fileId, ext);
    const existing = await stat(target).catch(() => undefined);
    if (existing?.size === input.size) return target;

    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await pipeline(input.stream(), createWriteStream(tmp));
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    return target;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMediaStore,
  SessionMediaStoreService,
  ScopeActivation.OnScopeCreated,
  'media',
);
