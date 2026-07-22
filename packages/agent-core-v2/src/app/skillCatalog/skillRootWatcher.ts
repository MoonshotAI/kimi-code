/**
 * `skillCatalog` domain (L3) — filesystem watcher for skill-root directories.
 *
 * Watches candidate skill roots through `IHostFsWatchService`, probes them
 * through `IHostFileSystem`, and fires a 300 ms debounced change callback
 * whenever any of them changes. Candidates may not exist yet (skill
 * directories are opt-in). chokidar 4 (verified
 * 4.0.3 on darwin): a recursive watch on a path whose immediate parent
 * exists picks the path up when it is created, but a path with two or more
 * missing leading segments reports NOTHING when the chain appears. So an
 * absent root is tracked by a depth-0 watch on the nearest existing ancestor
 * that re-anchors down the chain as segments appear — ancestor-watch
 * events only trigger an existence re-probe (a `mkdir -p` chain is never
 * missed) — and once the root exists a recursive watch is armed in its
 * place. Root deletion while armed falls back to ancestor-watch mode on the
 * next advance, so delete/recreate cycles stay live. Pure helper owned by the
 * file-backed skill sources; not a DI service.
 */

import { dirname } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { HostFsChange, IHostFsWatchHandle, IHostFsWatchService } from '#/os/interface/hostFsWatch';

import { isDir } from './skillRoots';

const SKILL_WATCH_DEBOUNCE_MS = 300;

interface RootWatchState {
  readonly root: string;
  rootWatch: IHostFsWatchHandle | undefined;
  ancestorWatch: IHostFsWatchHandle | undefined;
  watchedAncestorDir: string | undefined;
  advanceTail: Promise<void>;
}

export class SkillRootWatcher extends Disposable {
  private readonly states = new Map<string, RootWatchState>();
  private armTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  readonly ready: Promise<void>;

  constructor(
    private readonly hostFs: IHostFileSystem,
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
        ancestorWatch: undefined,
        watchedAncestorDir: undefined,
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
    state.ancestorWatch?.dispose();
    state.ancestorWatch = undefined;
    state.watchedAncestorDir = undefined;
  }

  private advance(state: RootWatchState): void {
    const tail = state.advanceTail.then(async () => {
      if (this.disposed || this.states.get(state.root) !== state) return;
      if (await isDir(this.hostFs, state.root)) {
        if (state.rootWatch !== undefined) return;
        // A previously armed ancestor watch means the root just appeared
        // (possibly with content already inside): the transition itself is a
        // change.
        const appeared = state.ancestorWatch !== undefined;
        state.ancestorWatch?.dispose();
        state.ancestorWatch = undefined;
        state.watchedAncestorDir = undefined;
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
      const anchor = await nearestExistingDir(this.hostFs, state.root);
      if (this.disposed || this.states.get(state.root) !== state) return;
      if (state.ancestorWatch !== undefined && state.watchedAncestorDir === anchor) return;
      state.ancestorWatch?.dispose();
      const ancestorWatch = this.hostFsWatch.watch(anchor, { recursive: false });
      state.ancestorWatch = ancestorWatch;
      state.watchedAncestorDir = anchor;
      ancestorWatch.onDidChange((event) => {
        this.onAncestorWatchEvent(state, event);
      });
    });
    state.advanceTail = tail.catch(() => undefined);
  }

  private onAncestorWatchEvent(state: RootWatchState, event: HostFsChange): void {
    if (isOnRootChain(state.root, event.path)) this.advance(state);
  }

  private scheduleFire(): void {
    if (this.disposed) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    const timer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.disposed) return;
      this.onDidChange();
      // Re-probe every root: a deleted armed root falls back to ancestor-watch
      // mode here, and a missed transition is re-armed on the new root.
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

async function nearestExistingDir(fs: IHostFileSystem, root: string): Promise<string> {
  let current = root;
  while (true) {
    if (await isDir(fs, current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
