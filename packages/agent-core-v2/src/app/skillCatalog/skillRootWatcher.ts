/**
 * `skillCatalog` domain (L3) — filesystem watcher for skill-root directories.
 *
 * Watches candidate skill roots through `IHostFsWatchService` and fires a
 * 300 ms debounced change callback whenever any of them changes. Candidates
 * may not exist yet (skill directories are opt-in). chokidar 4 (verified
 * 4.0.3 on darwin): a recursive watch on a path whose immediate parent
 * exists picks the path up when it is created, but a path with two or more
 * missing leading segments reports NOTHING when the chain appears. So an
 * absent root is tracked by a depth-0 sentinel on the nearest existing
 * ancestor that re-anchors down the chain as segments appear — sentinel
 * events only trigger an existence re-probe (a `mkdir -p` chain is never
 * missed) — and once the root exists a recursive watch is armed in its
 * place. Root deletion while armed falls back to sentinel mode on the next
 * advance, so delete/recreate cycles stay live. Pure helper owned by the
 * file-backed skill sources; not a DI service.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import type { HostFsChange, IHostFsWatchHandle, IHostFsWatchService } from '#/os/interface/hostFsWatch';

const SKILL_WATCH_DEBOUNCE_MS = 300;

interface RootWatchState {
  readonly root: string;
  rootWatch: IHostFsWatchHandle | undefined;
  sentinel: IHostFsWatchHandle | undefined;
  sentinelDir: string | undefined;
  advanceTail: Promise<void>;
}

export class SkillRootWatcher extends Disposable {
  private readonly states = new Map<string, RootWatchState>();
  private armTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  readonly ready: Promise<void>;

  constructor(
    private readonly hostFsWatch: IHostFsWatchService,
    private readonly resolveRoots: () => Promise<readonly string[]>,
    private readonly onDidChange: () => void,
  ) {
    super();
    this.ready = this.rearm();
  }

  refresh(): Promise<void> {
    return this.rearm();
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const state of this.states.values()) this.teardownState(state);
    this.states.clear();
    super.dispose();
  }

  private rearm(): Promise<void> {
    const tail = this.armTail.then(() => this.rearmNow());
    this.armTail = tail.catch(() => undefined);
    return tail;
  }

  private async rearmNow(): Promise<void> {
    if (this.disposed) return;
    for (const state of this.states.values()) this.teardownState(state);
    this.states.clear();
    const roots = await this.resolveRoots();
    if (this.disposed) return;
    const advances: Promise<void>[] = [];
    for (const root of new Set(roots)) {
      const state: RootWatchState = {
        root,
        rootWatch: undefined,
        sentinel: undefined,
        sentinelDir: undefined,
        advanceTail: Promise.resolve(),
      };
      this.states.set(root, state);
      this.advance(state);
      advances.push(state.advanceTail);
    }
    await Promise.all(advances);
  }

  private teardownState(state: RootWatchState): void {
    state.rootWatch?.dispose();
    state.rootWatch = undefined;
    state.sentinel?.dispose();
    state.sentinel = undefined;
    state.sentinelDir = undefined;
  }

  private advance(state: RootWatchState): void {
    const tail = state.advanceTail.then(async () => {
      if (this.disposed || this.states.get(state.root) !== state) return;
      if (await isDir(state.root)) {
        if (state.rootWatch !== undefined) return;
        // A previously armed sentinel means the root just appeared (possibly
        // with content already inside): the transition itself is a change.
        const appeared = state.sentinel !== undefined;
        state.sentinel?.dispose();
        state.sentinel = undefined;
        state.sentinelDir = undefined;
        if (this.disposed || this.states.get(state.root) !== state) return;
        const handle = this.hostFsWatch.watch(state.root);
        state.rootWatch = handle;
        handle.onDidChange(() => {
          this.scheduleFire();
        });
        if (appeared) this.scheduleFire();
        return;
      }
      state.rootWatch?.dispose();
      state.rootWatch = undefined;
      const anchor = await nearestExistingDir(state.root);
      if (this.disposed || this.states.get(state.root) !== state) return;
      if (state.sentinel !== undefined && state.sentinelDir === anchor) return;
      state.sentinel?.dispose();
      const sentinel = this.hostFsWatch.watch(anchor, { recursive: false });
      state.sentinel = sentinel;
      state.sentinelDir = anchor;
      sentinel.onDidChange((event) => {
        this.onSentinelEvent(state, event);
      });
    });
    state.advanceTail = tail.catch(() => undefined);
  }

  private onSentinelEvent(state: RootWatchState, event: HostFsChange): void {
    if (isOnRootChain(state.root, event.path)) this.advance(state);
  }

  private scheduleFire(): void {
    if (this.disposed) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    const timer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.disposed) return;
      this.onDidChange();
      // Re-probe every root: a deleted armed root falls back to sentinel mode
      // here, and a missed sentinel transition is re-armed on the new root.
      for (const state of this.states.values()) this.advance(state);
    }, SKILL_WATCH_DEBOUNCE_MS);
    timer.unref?.();
    this.debounceTimer = timer;
  }
}

function isOnRootChain(root: string, eventPath: string): boolean {
  if (eventPath === root) return true;
  return (
    root.startsWith(eventPath) &&
    (root[eventPath.length] === '/' || root[eventPath.length] === '\\')
  );
}

async function nearestExistingDir(root: string): Promise<string> {
  let current = root;
  while (true) {
    if (await isDir(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
