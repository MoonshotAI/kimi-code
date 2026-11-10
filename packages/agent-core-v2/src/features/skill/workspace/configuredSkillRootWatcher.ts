import { realpath } from 'node:fs/promises';
import { basename, dirname, join, parse, relative } from 'node:path';

import { Disposable, DisposableMap } from '#/_base/di/lifecycle';
import type { ILogService } from '#/_base/log/log';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { isSkillScanExcludedEntry, MAX_SKILL_SCAN_DEPTH } from '#/features/skill/catalog/fileSkillDiscovery';
import { configuredRootCandidates } from '#/features/skill/catalog/skillRoots';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isWatchEnabled, watch, watchCandidates, type WatchHandle } from '#human/utils/watch';

const WATCH_DEBOUNCE_MS = 200;

interface ConfiguredSkillRootWatchOptions {
  readonly dirs: readonly string[];
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly source: 'explicit' | 'extra';
  readonly fs: IHostFileSystem;
  readonly log?: ILogService;
}

export class ConfiguredSkillRootWatcher extends Disposable {
  readonly registered: Promise<void>;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watches = this._register(new DisposableMap<string, WatchHandle>());
  private watchRevision = 0;

  constructor(
    private readonly options: ConfiguredSkillRootWatchOptions,
    private readonly onChange: () => void,
  ) {
    super();
    this.registered = options.dirs.length === 0 ? Promise.resolve() : this.watchSkillRoots(options.dirs);
  }

  private async watchSkillRoots(dirs: readonly string[]): Promise<void> {
    if (!isWatchEnabled()) return;
    const candidates = await configuredRootCandidates(dirs, this.options.cwd, this.options.osHomeDir, this.options.fs);
    await this.updateWatches(candidates);
  }

  private async updateWatches(candidates: readonly string[]): Promise<void> {
    if (this._store.isDisposed) return;
    const revision = ++this.watchRevision;
    const resolved = new Map<string, Promise<string | undefined>>();
    const resolve = (path: string) => {
      let pending = resolved.get(path);
      if (pending === undefined) {
        pending = (this.options.fs?.realpath(path) ?? realpath(path)).catch(() => undefined);
        resolved.set(path, pending);
      }
      return pending;
    };
    const plan = new Map<string, { path: string; entry?: string }>();
    for (const candidate of candidates) {
      const target = await resolve(candidate);
      if (target !== undefined) plan.set(`target:${target}`, { path: target });
      for (let entry = candidate; dirname(entry) !== entry; entry = dirname(entry)) {
        const parent = await resolve(dirname(entry));
        if (parent === undefined) continue;
        const entryPath = join(parent, basename(entry));
        const resolvedEntry = await resolve(entry);
        if (entry === candidate || resolvedEntry === undefined || relative(entryPath, resolvedEntry) !== '') {
          plan.set(`entry:${entryPath}`, { path: parent, entry: entryPath });
        }
      }
    }
    if (this._store.isDisposed || revision !== this.watchRevision) return;
    for (const [key, { path, entry }] of plan) {
      if (this.watches.has(key)) continue;
      const logFailure = (error: unknown) => {
        if (!this._store.isDisposed) {
          this.options.log?.warn(`${this.options.source} skill watcher failed for ${entry ?? path}: ${String(error)}`);
        }
      };
      try {
        const handle = entry === undefined
          ? this.watchTarget(path)
          : watch(path, {
              ignored: (changed) => relative(path, changed) !== '' && relative(entry, changed) !== '',
              listing: false,
              recursive: false,
            });
        this.watches.set(key, handle);
        handle.onDidChange(() => {
          if (entry !== undefined) void this.updateWatches(candidates);
          this.invalidate();
        });
        void handle.ready.then(() => {
          if (this.watches.get(key) !== handle) return;
          if (entry === undefined) this.invalidate();
          else void this.updateWatches(candidates);
        }, logFailure);
      } catch (error) {
        this.watches.deleteAndDispose(key);
        logFailure(error);
      }
    }
    for (const key of this.watches.keys()) {
      if (plan.has(key)) continue;
      this.watches.deleteAndDispose(key);
      this.invalidate();
    }
  }

  private watchTarget(path: string): WatchHandle {
    const root = parse(path).root;
    return watchCandidates(root, [path], {
      ignored: subtreeWatchFilter(root, [path.replace(/[\\/]+$/, '')], {
        maxDepth: MAX_SKILL_SCAN_DEPTH + 2,
        skipEntry: isSkillScanExcludedEntry,
        keepEntryFile: 'SKILL.md',
      }),
      signal: true,
    });
  }

  private invalidate(): void {
    if (this._store.isDisposed) return;
    this.watchDebounce.cancelAndSet(() => {
      this.onChange();
    }, WATCH_DEBOUNCE_MS);
  }
}
