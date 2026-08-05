/**
 * `media` domain — `ISessionMediaStore` contract.
 *
 * Owns the per-session `media/` dir: the access pattern for materializing
 * daemon-upload bytes into files the model can open by absolute path, and for
 * resolving a daemon reference's display path. `pathFor` is the
 * session-canonical location (`<sessionDir>/media/<fileId><ext>`), a pure
 * function of the session and the ids. `resolveDisplayPath` answers the path
 * the model should re-open: the canonical copy when one exists — the
 * persisted hint may point at another session's dir after a fork, or at a
 * relocated home — and the hint otherwise (including when absent).
 * `materialize` writes the bytes atomically and derives the extension from
 * the reference hint, then the upload name, then the MIME fallback, so every
 * caller lands on the same target. Business code (prompt intake, the
 * request-time resolver, server edges) never touches the filesystem for
 * these copies — it goes through this store. Bound at Session scope (the
 * `media/` dir is shared by every agent of the session and copied on fork).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionMediaStore {
  readonly _serviceBrand: undefined;

  pathFor(fileId: string, ext: string): string;

  resolveDisplayPath(fileId: string, hint: string | undefined): Promise<string | undefined>;

  materialize(input: {
    readonly fileId: string;
    readonly size: number;
    readonly name: string;
    readonly mimeType: string;
    readonly hintPath?: string;
    readonly stream: () => NodeJS.ReadableStream;
  }): Promise<string>;
}

export const ISessionMediaStore: ServiceIdentifier<ISessionMediaStore> =
  createDecorator<ISessionMediaStore>('sessionMediaStore');
