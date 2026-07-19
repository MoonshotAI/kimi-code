/**
 * `sessionFsWatch` domain (L2) — `ISessionFsWatchService` implementation.
 *
 * Subscribes to the os `IHostFsWatchService` on the workspace root, confines
 * events to the caller-declared subtree and to non-`.gitignore`d paths,
 * debounces them into fixed windows and re-exposes them as workspace-relative
 * `FsChangeEvent`s. Path confinement is lexical (`ISessionWorkspaceContext.isWithin`),
 * matching `sessionFs`.
 *
 * Two independent watch sets feed confinement: client subscriptions
 * (`setWatchedPaths`, workspace-relative, replace semantics) and ensured
 * roots (`ensureWatchedRoots`, absolute, additive — used by the
 * optimistic-concurrency ledger). An ensured root inside the workDir is
 * covered by the workDir watcher; one outside gets its own os handle whose
 * events skip the workDir `.gitignore` filter and are never re-emitted as
 * `FsChangeEvent`s (protocol paths are workspace-relative) — they only fold
 * into dirty state. The os workDir watcher runs while either set is
 * non-empty.
 *
 * Dirty state: every confined change entry gets the next monotonic tick and
 * is buffered with it; at flush the entries fold into
 * `dirtyTicks[normalizedAbs]`, and a truncated window (exact paths dropped)
 * conservatively folds `dirtyRootTicks` for every watched root at the
 * window's last tick. Clearing a window without flushing still folds the
 * buffered entries so in-flight dirty signals are never silently dropped.
 * Key normalization is the shared `normalizeFsWatchKey` from the contract.
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import ignore, { type Ignore } from 'ignore';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { FsChangeEvent } from './fsWatch';

import { ISessionFsWatchService, isFsWatchKeyWithin, normalizeFsWatchKey } from './fsWatch';

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_CHANGES_PER_WINDOW = 500;

interface PendingChange {
  readonly abs: string;
  readonly rel: string | undefined;
  readonly tick: number;
  readonly change: HostFsChange['action'];
  readonly kind: HostFsChange['kind'];
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class SessionFsWatchService extends Disposable implements ISessionFsWatchService {
  declare readonly _serviceBrand: undefined;

  private readonly emitter = this._register(new Emitter<FsChangeEvent>());
  readonly onDidChangeFiles: Event<FsChangeEvent> = this.emitter.event;

  private watched = new Set<string>();
  private readonly ensured = new Map<string, string>();
  private handle: IHostFsWatchHandle | undefined;
  private handleSub: IDisposable | undefined;
  private readonly extraHandles = new Map<
    string,
    { readonly handle: IHostFsWatchHandle; readonly sub: IDisposable }
  >();

  private debounceTimer: NodeJS.Timeout | undefined;
  private pending: PendingChange[] = [];
  private rawCount = 0;
  private truncated = false;

  private tick = 0;
  private readonly dirtyTicks = new Map<string, number>();
  private readonly dirtyRootTicks = new Map<string, number>();

  private readonly debounceMs = readPositiveIntEnv(
    'KIMI_CODE_FS_WATCH_DEBOUNCE_MS',
    DEFAULT_DEBOUNCE_MS,
  );
  private readonly maxChangesPerWindow = readPositiveIntEnv(
    'KIMI_CODE_FS_WATCH_MAX_CHANGES_PER_WINDOW',
    DEFAULT_MAX_CHANGES_PER_WINDOW,
  );

  // The matcher is the entire filter state — a rules change swaps it in
  // whole, nothing else is kept. Rules load asynchronously: until the
  // initial load settles, filtering conservatively uses the base rules
  // (only `.git/`), i.e. unknown-but-maybe-ignored paths still pass through.
  private matcher: Ignore = ignore().add('.git/');
  private gitignoreLoaded = false;

  constructor(
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IHostFsWatchService private readonly hostFsWatch: IHostFsWatchService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {
    super();
  }

  get watchedPaths(): readonly string[] {
    return Array.from(this.watched);
  }

  get watchedRoots(): readonly string[] {
    const out = new Map<string, string>();
    for (const rel of this.watched) {
      const abs = this.workspace.resolve(rel);
      out.set(normalizeFsWatchKey(abs), abs);
    }
    for (const [key, abs] of this.ensured) out.set(key, abs);
    return Array.from(out.values());
  }

  get currentTick(): number {
    return this.tick;
  }

  dirtyTickFor(path: string): number | undefined {
    return this.dirtyTicks.get(normalizeFsWatchKey(path));
  }

  rootDirtyTickFor(root: string): number | undefined {
    return this.dirtyRootTicks.get(normalizeFsWatchKey(root));
  }

  setWatchedPaths(paths: readonly string[]): void {
    const next = new Set<string>();
    for (const p of paths) {
      const abs = this.resolveWithin(p);
      next.add(this.toRel(abs));
    }
    this.watched = next;
    if (next.size === 0 && this.ensured.size === 0) {
      this.teardownHandle();
      this.clearWindow();
      return;
    }
    this.ensureHandle();
  }

  ensureWatchedRoots(roots: readonly string[]): void {
    let changed = false;
    for (const root of roots) {
      const abs = resolve(root);
      if (this.isCovered(abs)) continue;
      const key = normalizeFsWatchKey(abs);
      this.ensured.set(key, abs);
      changed = true;
      if (!isFsWatchKeyWithin(key, normalizeFsWatchKey(this.workspace.workDir))) {
        this.startExtraHandle(key, abs);
      }
    }
    if (changed || this.watched.size > 0) this.ensureHandle();
  }

  private isCovered(abs: string): boolean {
    const key = normalizeFsWatchKey(abs);
    for (const root of this.watchedRoots) {
      if (isFsWatchKeyWithin(key, normalizeFsWatchKey(root))) return true;
    }
    return false;
  }

  private startExtraHandle(key: string, abs: string): void {
    if (this.extraHandles.has(key)) return;
    const handle = this.hostFsWatch.watch(abs, { recursive: true });
    const sub = handle.onDidChange((e) => this.onRawExtra(key, e));
    this.extraHandles.set(key, { handle, sub });
  }

  private ensureHandle(): void {
    if (this.handle !== undefined) return;
    if (this.watched.size === 0 && this.ensured.size === 0) return;
    this.loadGitignore();
    const handle = this.hostFsWatch.watch(this.workspace.workDir, { recursive: true });
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
    void this.reloadGitignore();
  }

  private async reloadGitignore(): Promise<void> {
    const next = ignore().add('.git/');
    try {
      next.add(await this.hostFs.readText(join(this.workspace.workDir, '.gitignore')));
    } catch {
      // Missing or unreadable `.gitignore` — fall back to the base rules.
    }
    this.matcher = next;
  }

  private onRaw(e: HostFsChange): void {
    const rel = this.toRel(e.path);
    if (rel === '.') return;
    // A change to the workspace-root `.gitignore` invalidates the filter
    // rules: rebuild the matcher asynchronously (the recursive watcher already
    // delivers this event, so no extra watcher is needed). Events arriving
    // while the rebuild is in flight are filtered by the previous matcher.
    if (rel === '.gitignore' && e.kind !== 'directory') {
      void this.reloadGitignore();
    }
    const probe = e.kind === 'directory' ? `${rel}/` : rel;
    if (this.matcher.ignores(probe)) return;
    if (isUnderAny(rel, this.watched)) {
      this.record(e, rel);
      return;
    }
    const key = normalizeFsWatchKey(e.path);
    for (const rootKey of this.ensured.keys()) {
      if (isFsWatchKeyWithin(key, rootKey)) {
        this.record(e, rel);
        return;
      }
    }
  }

  private onRawExtra(rootKey: string, e: HostFsChange): void {
    if (!isFsWatchKeyWithin(normalizeFsWatchKey(e.path), rootKey)) return;
    this.record(e, undefined);
  }

  private record(e: HostFsChange, rel: string | undefined): void {
    this.tick += 1;
    this.pending.push({ abs: e.path, rel, tick: this.tick, change: e.action, kind: e.kind });
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
    if (this.rawCount === 0) return;
    const truncated = this.truncated;
    const count = this.rawCount;
    const pending = this.pending;
    this.pending = [];
    this.rawCount = 0;
    this.truncated = false;

    if (truncated) {
      for (const root of this.watchedRoots) {
        this.dirtyRootTicks.set(normalizeFsWatchKey(root), this.tick);
      }
    } else {
      for (const entry of pending) {
        this.dirtyTicks.set(normalizeFsWatchKey(entry.abs), entry.tick);
      }
    }

    const changes = truncated
      ? []
      : pending
          .filter((entry) => entry.rel !== undefined)
          .map((entry) => ({
            path: entry.rel!,
            change: entry.change,
            kind: entry.kind,
          }));
    if (truncated || changes.length > 0) {
      const event: FsChangeEvent = {
        changes,
        coalesced_window_ms: this.debounceMs,
        ...(truncated ? { truncated: true, count } : {}),
      };
      this.emitter.fire(event);
    }
  }

  private clearWindow(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const entry of this.pending) {
      this.dirtyTicks.set(normalizeFsWatchKey(entry.abs), entry.tick);
    }
    this.pending = [];
    this.rawCount = 0;
    this.truncated = false;
  }

  override dispose(): void {
    this.clearWindow();
    this.teardownHandle();
    for (const { handle, sub } of this.extraHandles.values()) {
      sub.dispose();
      handle.dispose();
    }
    this.extraHandles.clear();
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
    const abs = this.workspace.resolve(inputPath);
    if (!this.workspace.isWithin(abs)) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" escapes workspace`, {
        details: { path: inputPath, reason: 'resolved_outside' },
      });
    }
    return abs;
  }

  private toRel(abs: string): string {
    const cwd = this.workspace.workDir;
    if (abs === cwd) return '.';
    const rel = relative(cwd, abs);
    if (rel === '') return '.';
    return rel.split(sep).join('/');
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
  LifecycleScope.Session,
  ISessionFsWatchService,
  SessionFsWatchService,
  InstantiationType.Eager,
  'sessionFsWatch',
);
