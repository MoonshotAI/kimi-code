/**
 * `sessionFileLedger` domain (L2) — `ISessionFileLedger` implementation.
 *
 * In-memory per-session ledger of on-disk stat tuples keyed by
 * `normalizeFsWatchKey`. `recordBaseline` re-stats the target through
 * `IHostFileSystem` and stores the tuple with the watch service's current
 * tick; `compare` consults only already-folded `sessionFsWatch` dirty state
 * (it never awaits watcher frames) and degrades gracefully: stat failures
 * other than not-found yield `clean` rather than blocking the write path,
 * and paths outside every watched root get a stat-only comparison. The
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
    const tuple = await this.tryStat(path);
    if (tuple === undefined) return;
    this.entries.set(normalizeFsWatchKey(path), { ...tuple, tick: this.watch.currentTick });
  }

  async compare(path: string): Promise<FileLedgerVerdict> {
    this.ensureWatchedRootFor(path);
    const key = normalizeFsWatchKey(path);
    const entry = this.entries.get(key);
    const root = this.containingWatchedRoot(key);
    if (root === undefined) {
      const current = await this.tryStat(path);
      if (current === undefined) return 'clean';
      if (entry === undefined) return current.exists ? 'no-baseline' : 'clean';
      return fileStatTuplesEqual(entry, current) ? 'clean' : 'stale';
    }
    if (entry === undefined) {
      if ((this.watch.dirtyTickFor(path) ?? 0) > 0) return 'stale';
      const current = await this.tryStat(path);
      if (current === undefined) return 'clean';
      return current.exists ? 'no-baseline' : 'clean';
    }
    const dirty = Math.max(
      this.watch.dirtyTickFor(path) ?? 0,
      this.watch.rootDirtyTickFor(root) ?? 0,
    );
    if (dirty <= entry.tick) return 'clean';
    const current = await this.tryStat(path);
    if (current === undefined) return 'clean';
    if (fileStatTuplesEqual(entry, current)) {
      this.entries.set(key, { ...entry, tick: dirty });
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
