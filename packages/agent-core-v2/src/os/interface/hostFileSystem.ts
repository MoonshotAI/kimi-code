/**
 * `hostFs` domain (L1) — local real-filesystem primitives.
 *
 * Defines the `IHostFileSystem` used by the program side (persistence, skill
 * loading, workspace registry) and the os file tools to read and write files on
 * the real local disk, plus the stat/entry models. App-scoped — one shared
 * instance.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TextDecodeErrors } from '#/_base/execEnv/decodeText';

export interface HostFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /**
   * `true` when the path itself is a symbolic link (reported via a
   * non-following `lstat`). Lets callers surface `kind: 'symlink'` instead of
   * silently following the link and reporting the target's type.
   */
  readonly isSymbolicLink?: boolean;
  readonly size: number;
  /** Last-modified time in epoch milliseconds, when the backend exposes it. */
  readonly mtimeMs?: number;
  /** Inode number, when the backend exposes it (`0` on backends without inodes). */
  readonly ino?: number;
}

export interface HostDirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /**
   * `true` when the directory entry is a symbolic link (from `readdir`
   * `withFileTypes`). Does not follow the link — a symlink to a directory is
   * reported with `isSymbolicLink: true` and `isDirectory: false`.
   */
  readonly isSymbolicLink?: boolean;
}

export interface IHostFileSystem {
  readonly _serviceBrand: undefined;

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  /**
   * Append UTF-8 `data` to the end of `path`, creating the file if it does not
   * exist. Maps to a native append (POSIX `O_APPEND` / `fs.appendFile`): it
   * never reads or truncates existing content, so concurrent readers never see
   * a partially-rewritten file and a crash mid-write can lose only the new
   * bytes, never the prior contents. Prefer this over a read-then-rewrite for
   * log-style appends.
   */
  appendText(path: string, data: string): Promise<void>;
  /**
   * Read bytes from `path`. When `n` is given, reads at most the first `n`
   * bytes (a ranged/prefix read); otherwise reads the whole file. The ranged
   * form is used by callers that only need a header (e.g. file-type sniffing)
   * so they never load a large file just to inspect its first bytes.
   */
  readBytes(path: string, n?: number): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /**
   * Stream the lines of a UTF-8 (or other `encoding`) text file, yielding each
   * line including its trailing terminator. `errors` mirrors Python's text
   * decode error handling (`strict` throws on invalid bytes, used by the Read
   * tool to surface non-UTF-8 files). Streaming lets callers paginate and
   * stop early without loading the whole file.
   */
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string>;
  /**
   * Create a file exclusively with `data`. Returns `true` when the file was
   * created, `false` when it already existed (EEXIST) — the existing content is
   * left untouched. Used by content-addressed stores where a collision means
   * the same bytes are already present.
   */
  createExclusive(path: string, data: Uint8Array): Promise<boolean>;
  stat(path: string): Promise<HostFileStat>;
  readdir(path: string): Promise<readonly HostDirEntry[]>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
}

export const IHostFileSystem: ServiceIdentifier<IHostFileSystem> =
  createDecorator<IHostFileSystem>('hostFileSystem');
