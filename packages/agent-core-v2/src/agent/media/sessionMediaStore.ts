/**
 * `media` domain — `ISessionMediaStore` contract.
 *
 * Owns the per-session canonical media blobs through the persistence byte
 * store. It materializes daemon uploads, exposes a host path only when the
 * selected backend has one, and reads canonical bytes after a transient
 * daemon upload has been released. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionMediaStore {
  readonly _serviceBrand: undefined;

  pathFor(fileId: string, ext: string): string | undefined;

  resolveDisplayPath(fileId: string, hint: string | undefined): Promise<string | undefined>;

  read(
    fileId: string,
    hintPath?: string,
  ): Promise<{ readonly data: Uint8Array; readonly name: string } | undefined>;

  materialize(input: {
    readonly fileId: string;
    readonly size: number;
    readonly name: string;
    readonly mimeType: string;
    readonly hintPath?: string;
    readonly stream: () => NodeJS.ReadableStream;
    readonly signal?: AbortSignal;
  }): Promise<string | undefined>;
}

export const ISessionMediaStore: ServiceIdentifier<ISessionMediaStore> =
  createDecorator<ISessionMediaStore>('sessionMediaStore');
