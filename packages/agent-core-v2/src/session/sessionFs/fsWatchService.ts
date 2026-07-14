/**
 * `sessionFsWatch` domain (L2) — `ISessionFsWatchService` implementation.
 *
 * Subscribes to the os `IHostFsWatchService` on the workspace root, confines
 * events to the caller-declared subtree and to non-`.gitignore`d paths,
 * debounces them into fixed windows and re-exposes them as workspace-relative
 * `FsChangeEvent`s. The os watcher is started lazily on the first non-empty
 * subscription and stopped when the subscription set becomes empty. Path
 * confinement is lexical (`ISessionWorkspaceContext.isWithin`), matching
 * `sessionFs`.
 */

import { isAbsolute, join, relative, sep } from 'node:path';

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
import type { FsChangeEntry, FsChangeEvent } from '@moonshot-ai/protocol';

import { ISessionFsWatchService } from './fsWatch';

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_CHANGES_PER_WINDOW = 500;

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
  private handle: IHostFsWatchHandle | undefined;
  private handleSub: IDisposable | undefined;

  private debounceTimer: NodeJS.Timeout | undefined;
  private pending: FsChangeEntry[] = [];
  private rawCount = 0;
  private truncated = false;

  private readonly debounceMs = readPositiveIntEnv(
    'KIMI_CODE_FS_WATCH_DEBOUNCE_MS',
    DEFAULT_DEBOUNCE_MS,
  );
  private readonly maxChangesPerWindow = readPositiveIntEnv(
    'KIMI_CODE_FS_WATCH_MAX_CHANGES_PER_WINDOW',
    DEFAULT_MAX_CHANGES_PER_WINDOW,
  );

  private readonly matcher: Ignore = ignore().add('.git/');
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

  setWatchedPaths(paths: readonly string[]): void {
    const next = new Set<string>();
    for (const p of paths) {
      const abs = this.resolveWithin(p);
      next.add(this.toRel(abs));
    }
    this.watched = next;
    if (next.size === 0) {
      this.teardownHandle();
      this.clearWindow();
      return;
    }
    this.ensureHandle();
  }

  private ensureHandle(): void {
    if (this.handle !== undefined) return;
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
    void this.hostFs
      .readText(join(this.workspace.workDir, '.gitignore'))
      .then(
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
    if (!isUnderAny(rel, this.watched)) return;

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
    if (this.rawCount === 0) return;
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

  override dispose(): void {
    this.clearWindow();
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
  InstantiationType.Delayed,
  'sessionFsWatch',
);
