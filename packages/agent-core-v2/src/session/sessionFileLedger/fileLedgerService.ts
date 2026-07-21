/**
 * `sessionFileLedger` domain (L2) — `ISessionFileLedger` implementation.
 *
 * In-memory per-session ledger of on-disk stat tuples keyed by
 * `normalizeFsWatchKey`. `recordBaseline` stores the revision observed by
 * successful file I/O and `compare` always re-stats immediately before a
 * write decision. An unverifiable stat fails closed as `stale`.
 * Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { normalizeFsWatchKey } from '#/session/sessionFs/fsWatch';

import {
  ISessionFileLedger,
  fileStatTuplesEqual,
  type FileLedgerVerdict,
  type FileStatTuple,
} from './fileLedger';

export class SessionFileLedger implements ISessionFileLedger {
  declare readonly _serviceBrand: undefined;

  private readonly entries = new Map<string, FileStatTuple>();

  constructor(@IHostFileSystem private readonly hostFs: IHostFileSystem) {}

  recordBaseline(path: string, revision: FileStatTuple): void {
    this.entries.set(normalizeFsWatchKey(path), revision);
  }

  async compare(path: string): Promise<FileLedgerVerdict> {
    const key = normalizeFsWatchKey(path);
    const entry = this.entries.get(key);
    const current = await this.tryStat(path);
    if (current === undefined) return 'stale';
    if (entry === undefined) return current.exists ? 'no-baseline' : 'clean';
    return fileStatTuplesEqual(entry, current) ? 'clean' : 'stale';
  }

  private async tryStat(path: string): Promise<FileStatTuple | undefined> {
    try {
      const stat = await this.hostFs.stat(path);
      return { exists: true, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false };
      return undefined;
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionFileLedger,
  SessionFileLedger,
  InstantiationType.Eager,
  'sessionFileLedger',
);
