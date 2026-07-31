/**
 * `workspaceFs` domain — `IWorkspaceFsWatchService` implementation.
 *
 * Keeps ONE os `IHostFsWatchService` subscription on the handler root and
 * fans its raw events out to every `IWorkspaceFsWatchSubscription`: the
 * shared leg (the os handle plus the `.gitignore` matcher) runs once per
 * handler, the per-subscriber leg (subtree confinement, debounce window,
 * overflow truncation) runs once per subscription, so two sessions of the
 * same workspace never hang a second os watcher. The os handle starts
 * lazily when the first subscription declares a non-empty path set and
 * stops when no subscription watches anything. Path confinement is lexical
 * (the handler root plus the `workspaceDirs` additional-dir set), matching
 * the rest of `workspaceFs`. Bound at Workspace scope.
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import ignore, { type Ignore } from 'ignore';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';

import {
  type FsChangeEntry,
  type FsChangeEvent,
  IWorkspaceFsWatchService,
  type IWorkspaceFsWatchSubscription,
} from './fsWatch';

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_CHANGES_PER_WINDOW = 500;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class WorkspaceFsWatchService extends Disposable implements IWorkspaceFsWatchService {
  declare readonly _serviceBrand: undefined;

  private readonly subscriptions = new Set<WorkspaceFsWatchSubscription>();
  private handle: IHostFsWatchHandle | undefined;
  private handleSub: IDisposable | undefined;
  private gitignoreLoaded = false;
  private readonly matcher: Ignore = ignore().add('.git/');
  private readonly workDir: string;

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IWorkspaceDirs private readonly workspaceDirs: IWorkspaceDirs,
    @IHostFsWatchService private readonly hostFsWatch: IHostFsWatchService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {
    super();
    this.workDir = resolve(workspace.cwd);
  }

  subscribe(): IWorkspaceFsWatchSubscription {
    const subscription = new WorkspaceFsWatchSubscription(this);
    this.subscriptions.add(subscription);
    return subscription;
  }

  normalizeWatchedPaths(paths: readonly string[]): Set<string> {
    const next = new Set<string>();
    for (const p of paths) {
      const abs = this.resolveWithin(p);
      next.add(this.toRel(abs));
    }
    return next;
  }

  syncHandle(): void {
    for (const sub of this.subscriptions) {
      if (sub.hasPaths()) {
        this.ensureHandle();
        return;
      }
    }
    this.teardownHandle();
  }

  dropSubscription(subscription: WorkspaceFsWatchSubscription): void {
    this.subscriptions.delete(subscription);
    this.syncHandle();
  }

  private ensureHandle(): void {
    if (this.handle !== undefined) return;
    this.loadGitignore();
    const handle = this.hostFsWatch.watch(this.workDir, { recursive: true });
    this.handle = handle;
    this.handleSub = handle.onDidChange((e) => this.onRaw(e));
  }

  private teardownHandle(): void {
    this.handleSub?.dispose();
    this.handleSub = undefined;
    this.handle?.dispose();
    this.handle = undefined;
  }

  private loadGitignore(): void {
    if (this.gitignoreLoaded) return;
    this.gitignoreLoaded = true;
    void this.hostFs.readText(join(this.workDir, '.gitignore')).then(
      (content) => {
        this.matcher.add(content);
      },
      () => undefined,
    );
  }

  private onRaw(e: HostFsChange): void {
    const rel = this.toRel(e.path);
    if (rel === '.') return;
    const probe = e.kind === 'directory' ? `${rel}/` : rel;
    if (this.matcher.ignores(probe)) return;
    for (const sub of this.subscriptions) {
      sub.onRawChange(rel, e);
    }
  }

  override dispose(): void {
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.clear();
    this.teardownHandle();
    super.dispose();
  }

  private resolveWithin(inputPath: string): string {
    if (inputPath === '' || inputPath === '/') {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (empty)`, {
        details: { path: inputPath, reason: 'empty' },
      });
    }
    if (isAbsolute(inputPath)) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (absolute)`, {
        details: { path: inputPath, reason: 'absolute' },
      });
    }
    const segments = inputPath.split(/[/\\]+/);
    if (segments.some((s) => s === '..')) {
      throw new Error2(
        ErrorCodes.FS_PATH_ESCAPES,
        `path "${inputPath}" rejected (dotdot segment)`,
        { details: { path: inputPath, reason: 'dotdot_segment' } },
      );
    }
    const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(this.workDir, inputPath);
    if (!this.isWithinWorkspace(abs)) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" escapes workspace`, {
        details: { path: inputPath, reason: 'resolved_outside' },
      });
    }
    return abs;
  }

  private isWithinWorkspace(absPath: string): boolean {
    const target = resolve(absPath);
    if (target === this.workDir) return true;
    const rel = relative(this.workDir, target);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true;
    return this.workspaceDirs.additionalDirs.some((dir) => {
      const r = relative(resolve(dir), target);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    });
  }

  private toRel(abs: string): string {
    const cwd = this.workDir;
    if (abs === cwd) return '.';
    const rel = relative(cwd, abs);
    if (rel === '') return '.';
    return rel.split(sep).join('/');
  }
}

class WorkspaceFsWatchSubscription implements IWorkspaceFsWatchSubscription {
  private readonly emitter = new Emitter<FsChangeEvent>();
  readonly onDidChangeFiles: Event<FsChangeEvent> = this.emitter.event;

  private watched = new Set<string>();
  private pending: FsChangeEntry[] = [];
  private rawCount = 0;
  private truncated = false;
  private debounceTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  private readonly debounceMs = readPositiveIntEnv(
    'KIMI_CODE_FS_WATCH_DEBOUNCE_MS',
    DEFAULT_DEBOUNCE_MS,
  );
  private readonly maxChangesPerWindow = readPositiveIntEnv(
    'KIMI_CODE_FS_WATCH_MAX_CHANGES_PER_WINDOW',
    DEFAULT_MAX_CHANGES_PER_WINDOW,
  );

  constructor(private readonly owner: WorkspaceFsWatchService) {}

  get watchedPaths(): readonly string[] {
    return Array.from(this.watched);
  }

  hasPaths(): boolean {
    return !this.disposed && this.watched.size > 0;
  }

  setWatchedPaths(paths: readonly string[]): void {
    if (this.disposed) return;
    this.watched = this.owner.normalizeWatchedPaths(paths);
    if (this.watched.size === 0) {
      this.clearWindow();
    }
    this.owner.syncHandle();
  }

  onRawChange(rel: string, e: HostFsChange): void {
    if (this.disposed || !isUnderAny(rel, this.watched)) return;
    this.pending.push({ path: rel, change: e.action, kind: e.kind });
    this.rawCount += 1;
    if (this.pending.length > this.maxChangesPerWindow) {
      this.truncated = true;
      this.pending = [];
    }
    if (this.debounceTimer === undefined) {
      const timer = setTimeout(() => this.flush(), this.debounceMs);
      timer.unref?.();
      this.debounceTimer = timer;
    }
  }

  private flush(): void {
    this.debounceTimer = undefined;
    if (this.disposed || this.rawCount === 0) return;
    const truncated = this.truncated;
    const count = this.rawCount;
    const changes = truncated ? [] : this.pending;
    this.pending = [];
    this.rawCount = 0;
    this.truncated = false;

    const event: FsChangeEvent = {
      changes,
      coalesced_window_ms: this.debounceMs,
      ...(truncated ? { truncated: true, count } : {}),
    };
    this.emitter.fire(event);
  }

  private clearWindow(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.pending = [];
    this.rawCount = 0;
    this.truncated = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearWindow();
    this.emitter.dispose();
    this.owner.dropSubscription(this);
  }
}

function isUnderAny(rel: string, parents: ReadonlySet<string>): boolean {
  for (const parent of parents) {
    if (parent === '.' || parent === '') return true;
    if (rel === parent) return true;
    if (rel.startsWith(`${parent}/`)) return true;
  }
  return false;
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceFsWatchService,
  WorkspaceFsWatchService,
  ScopeActivation.OnScopeCreated,
  'workspaceFs',
);
