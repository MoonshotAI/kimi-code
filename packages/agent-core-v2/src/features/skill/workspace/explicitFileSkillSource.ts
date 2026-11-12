import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { configuredRoots } from '#/features/skill/catalog/skillRoots';
import { ISkillDiscovery } from '#/features/skill/catalog/skillDiscovery';
import {
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/features/skill/catalog/skillSource';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { ConfiguredSkillRootWatcher } from './configuredSkillRootWatcher';

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
  private readonly watcher: ConfiguredSkillRootWatcher;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    private readonly fs: IHostFileSystem,
    log?: ILogService,
  ) {
    super();
    this.watcher = this._register(new ConfiguredSkillRootWatcher({
      dirs: bootstrap.args.skillDirs ?? [],
      cwd: workspace.cwd,
      osHomeDir: bootstrap.osHomeDir,
      source: this.id,
      fs,
      log,
    }, () => {
      this.onDidChangeEmitter.fire();
    }));
  }

  async load(): Promise<SkillContribution> {
    const explicitDirs = this.bootstrap.args.skillDirs ?? [];
    if (explicitDirs.length === 0) {
      return { skills: [] };
    }
    await this.watcher.registered;
    return this.discovery.discover(
      await configuredRoots(explicitDirs, this.workspace.cwd, this.bootstrap.osHomeDir, 'user', this.fs),
    );
  }
}
