/**
 * `sessionFileLedger` domain (L2) — `ISessionFileLedger` implementation.
 *
 * In-memory per-session ledger of on-disk file revisions keyed by
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
  fileRevisionsEqual,
  type FileLedgerVerdict,
  type FileRevision,
} from './fileLedger';

export class SessionFileLedger implements ISessionFileLedger {
  declare readonly _serviceBrand: undefined;

  private readonly baselines = new Map<string, FileRevision>();

  constructor(@IHostFileSystem private readonly hostFs: IHostFileSystem) {}

  recordBaseline(path: string, revision: FileRevision): void {
    this.baselines.set(normalizeFsWatchKey(path), revision);
  }

  async compare(path: string): Promise<FileLedgerVerdict> {
    const key = normalizeFsWatchKey(path);
    const baseline = this.baselines.get(key);
    const currentRevision = await this.tryStat(path);
    if (currentRevision === undefined) return 'stale';
    if (baseline === undefined) return currentRevision.exists ? 'no-baseline' : 'clean';
    return fileRevisionsEqual(baseline, currentRevision) ? 'clean' : 'stale';
  }

  private async tryStat(path: string): Promise<FileRevision | undefined> {
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
