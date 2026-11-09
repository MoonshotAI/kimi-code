import { parse } from 'node:path';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
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
import { isWatchEnabled, watchCandidates } from '#human/utils/watch';

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
    const candidates = await configuredRootCandidates(dirs, this.workspace.cwd, this.bootstrap.osHomeDir, this.fs);
    const paths = await Promise.all(candidates.map((path) => this.fs?.realpath(path).catch(() => path) ?? path));
    if (this._store.isDisposed || !isWatchEnabled()) return;
    const invalidate = () => {
      if (this._store.isDisposed) return;
      this.watchDebounce.cancelAndSet(() => {
        this.onDidChangeEmitter.fire();
      }, WATCH_DEBOUNCE_MS);
    };
    for (const path of new Set(paths)) {
      const logFailure = (error: unknown) => {
        if (this._store.isDisposed) return;
        this.log?.warn(`explicit skill watcher failed for ${path}: ${String(error)}`);
      };
      try {
        const root = parse(path).root;
        const handle = this._register(watchCandidates(root, [path], {
          ignored: subtreeWatchFilter(root, [path.replace(/[\\/]+$/, '')], {
            maxDepth: MAX_SKILL_SCAN_DEPTH + 2,
            skipEntry: isSkillScanExcludedEntry,
            keepEntryFile: 'SKILL.md',
          }),
          signal: true,
        }));
        this._register(handle.onDidChange(invalidate));
        void handle.ready.then(invalidate, logFailure);
      } catch (error) {
        logFailure(error);
      }
    }
  }
}

