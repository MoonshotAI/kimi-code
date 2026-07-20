/**
 * `sessionFileLedger` domain (L2) — `ISessionFileLedger` implementation.
 *
 * In-memory per-session ledger of on-disk stat tuples keyed by
 * `normalizeFsWatchKey`. `recordBaseline` captures the watch tick before it
 * re-stats the target, so a concurrent event cannot be absorbed into an older
 * tuple. `compare` always re-stats immediately before a write decision;
 * watcher ticks classify the result but never replace the stat. An
 * unverifiable stat fails closed as `stale`. The
 * service also guarantees `ISessionFsWatchService` watches the session roots
 * (`workDir` + `additionalDirs` from `ISessionWorkspaceContext`), adding an
 * unwatched containing root additively whenever a Write/Edit target falls
 * under one; writes outside all session roots proceed unwatched. Bound at
 * Session scope.
 */

import { resolve } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  ISessionFsWatchService,
  isFsWatchKeyWithin,
  normalizeFsWatchKey,
} from '#/session/sessionFs/fsWatch';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import {
  ISessionFileLedger,
  fileStatTuplesEqual,
  type FileLedgerVerdict,
  type FileStatTuple,
} from './fileLedger';

type FileLedgerEntry = FileStatTuple & { readonly tick: number };

export class SessionFileLedger implements ISessionFileLedger {
  declare readonly _serviceBrand: undefined;

  private readonly entries = new Map<string, FileLedgerEntry>();

  constructor(
    @ISessionFsWatchService private readonly watch: ISessionFsWatchService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {
    this.watch.ensureWatchedRoots(this.sessionRoots());
  }

  async recordBaseline(path: string): Promise<void> {
    this.ensureWatchedRootFor(path);
    const tick = this.watch.currentTick;
    const tuple = await this.tryStat(path);
    if (tuple === undefined) return;
    this.entries.set(normalizeFsWatchKey(path), { ...tuple, tick });
  }

  async compare(path: string): Promise<FileLedgerVerdict> {
    this.ensureWatchedRootFor(path);
    const key = normalizeFsWatchKey(path);
    const entry = this.entries.get(key);
    const root = this.containingWatchedRoot(key);
    const current = await this.tryStat(path);
    if (current === undefined) return 'stale';
    const dirty = Math.max(
      this.watch.dirtyTickFor(path) ?? 0,
      root === undefined ? 0 : (this.watch.rootDirtyTickFor(root) ?? 0),
    );
    if (entry === undefined) {
      if (dirty > 0) return current.exists ? 'stale' : 'clean';
      return current.exists ? 'no-baseline' : 'clean';
    }
    if (fileStatTuplesEqual(entry, current)) {
      if (dirty > entry.tick) this.entries.set(key, { ...current, tick: dirty });
      return 'clean';
    }
    return 'stale';
  }

  private sessionRoots(): readonly string[] {
    return [this.workspace.workDir, ...this.workspace.additionalDirs].map((dir) => resolve(dir));
  }

  private ensureWatchedRootFor(path: string): void {
    const root = this.longestContaining(normalizeFsWatchKey(path), this.sessionRoots());
    if (root !== undefined) this.watch.ensureWatchedRoots([root]);
  }

  private containingWatchedRoot(key: string): string | undefined {
    return this.longestContaining(key, this.watch.watchedRoots);
  }

  private longestContaining(key: string, roots: readonly string[]): string | undefined {
    let best: string | undefined;
    for (const root of roots) {
      if (!isFsWatchKeyWithin(key, normalizeFsWatchKey(root))) continue;
      if (best === undefined || root.length > best.length) best = root;
    }
    return best;
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
