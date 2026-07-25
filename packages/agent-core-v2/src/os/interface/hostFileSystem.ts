/**
 * `hostFs` domain (L1) — local real-filesystem primitives.
 *
 * Defines the `IHostFileSystem` used by the program side (persistence, skill
 * loading, workspace registry) and the os file tools to read and write files on
 * the real local disk, plus the stat/entry models. `realpath` canonicalizes a
 * path by resolving every symlink component (Node `fs.realpath` semantics) and
 * rejects with `os.fs.not_found` for a missing path; consumers use it to make
 * lexical path confinement symlink-aware. App-scoped — one shared instance.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TextDecodeErrors } from '#/_base/execEnv/decodeText';

export interface HostFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
}

export interface HostDirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
}

export interface IHostFileSystem {
  readonly _serviceBrand: undefined;

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  appendText(path: string, data: string): Promise<void>;
  readBytes(path: string, n?: number): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string>;
  createExclusive(path: string, data: Uint8Array): Promise<boolean>;
  /** Follows symlinks to the target (Node `stat` semantics). Use {@link lstat} when the link itself matters. */
  stat(path: string): Promise<HostFileStat>;
  /** Stats the entry itself without following symlinks (Node `lstat` semantics). */
  lstat(path: string): Promise<HostFileStat>;
  readdir(path: string): Promise<readonly HostDirEntry[]>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
}

export const IHostFileSystem: ServiceIdentifier<IHostFileSystem> =
  createDecorator<IHostFileSystem>('hostFileSystem');
