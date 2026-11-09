import { realpath } from 'node:fs/promises';
import { basename, dirname, join, parse, relative } from 'node:path';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, DisposableMap } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { isSkillScanExcludedEntry, MAX_SKILL_SCAN_DEPTH } from '#/features/skill/catalog/fileSkillDiscovery';
import { configuredRootCandidates, configuredRoots } from '#/features/skill/catalog/skillRoots';
import { ISkillDiscovery } from '#/features/skill/catalog/skillDiscovery';
import {
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/features/skill/catalog/skillSource';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { isWatchEnabled, watch, watchCandidates, type WatchHandle } from '#human/utils/watch';

const WATCH_DEBOUNCE_MS = 200;

export interface IExplicitFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IExplicitFileSkillSource: ServiceIdentifier<IExplicitFileSkillSource> =
  createDecorator<IExplicitFileSkillSource>('explicitFileSkillSource');

export class ExplicitFileSkillSource extends Disposable implements IExplicitFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'explicit';
  readonly priority = SKILL_SOURCE_PRIORITY.user;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchRegistered: Promise<void>;
  private readonly watches = this._register(new DisposableMap<string, WatchHandle>());
  private watchRevision = 0;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    private readonly fs: IHostFileSystem,
    private readonly log?: ILogService,
  ) {
    super();
    const dirs = this.bootstrap.args.skillDirs ?? [];
    this.watchRegistered = dirs.length === 0 ? Promise.resolve() : this.watchSkillRoots(dirs);
  }

  async load(): Promise<SkillContribution> {
    const explicitDirs = this.bootstrap.args.skillDirs ?? [];
    if (explicitDirs.length === 0) {
      return { skills: [] };
    }
    await this.watchRegistered;
    return this.discovery.discover(
      await configuredRoots(explicitDirs, this.workspace.cwd, this.bootstrap.osHomeDir, 'user', this.fs),
    );
  }

  private async watchSkillRoots(dirs: readonly string[]): Promise<void> {
    if (!isWatchEnabled()) return;
    const candidates = await configuredRootCandidates(dirs, this.workspace.cwd, this.bootstrap.osHomeDir, this.fs);
    await this.updateWatches(candidates);
  }

  private async updateWatches(candidates: readonly string[]): Promise<void> {
    if (this._store.isDisposed) return;
    const revision = ++this.watchRevision;
    const resolved = new Map<string, Promise<string | undefined>>();
    const resolve = (path: string) => {
      let pending = resolved.get(path);
      if (pending === undefined) {
        pending = (this.fs?.realpath(path) ?? realpath(path)).catch(() => undefined);
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
          this.log?.warn(`explicit skill watcher failed for ${entry ?? path}: ${String(error)}`);
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
      this.onDidChangeEmitter.fire();
    }, WATCH_DEBOUNCE_MS);
  }
}

