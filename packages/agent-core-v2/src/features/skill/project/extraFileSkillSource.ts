import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, MutableDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import {
  EXTRA_SKILL_DIRS_SECTION,
  type ExtraSkillDirsConfig,
} from '#/features/skill/catalog/configSection';
import { configuredRoots } from '#/features/skill/catalog/skillRoots';
import { ISkillDiscovery } from '#/features/skill/catalog/skillDiscovery';
import {
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/features/skill/catalog/skillSource';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';

import { ConfiguredSkillRootWatcher } from './configuredSkillRootWatcher';
import { projectSkillWorkDirs } from './rootFileSkillSource';

export interface IExtraFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IExtraFileSkillSource: ServiceIdentifier<IExtraFileSkillSource> =
  createDecorator<IExtraFileSkillSource>('extraFileSkillSource');

export class ExtraFileSkillSource extends Disposable implements IExtraFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'extra';
  readonly priority = SKILL_SOURCE_PRIORITY.extra;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watcher = this._register(new MutableDisposable<ConfiguredSkillRootWatcher>());
  private watchSignature: string | undefined;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IConfigService private readonly config: IConfigService,
    @IProjectContext private readonly project: IProjectContext,
    @IProjectDirs private readonly projectDirs: IProjectDirs,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    private readonly fs: IHostFileSystem,
    private readonly log?: ILogService,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === EXTRA_SKILL_DIRS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
    this._register(
      this.projectDirs.onDidChange(() => {
        if (this.configuredDirs().length > 0) this.onDidChangeEmitter.fire();
      }),
    );
  }

  private configuredDirs(): readonly string[] {
    return this.config.get<ExtraSkillDirsConfig>(EXTRA_SKILL_DIRS_SECTION) ?? [];
  }

  async load(): Promise<SkillContribution> {
    await Promise.all([this.config.ready, this.projectDirs.ready.catch(() => undefined)]);
    const extraSkillDirs = this.configuredDirs();
    const workDirs = projectSkillWorkDirs(this.projectDirs, this.project.cwd);
    const signature = JSON.stringify([extraSkillDirs, workDirs]);
    if (signature !== this.watchSignature) {
      this.watchSignature = signature;
      this.watcher.value = extraSkillDirs.length === 0
        ? undefined
        : new ConfiguredSkillRootWatcher({
            dirs: extraSkillDirs,
            workDirs,
            osHomeDir: this.bootstrap.osHomeDir,
            source: this.id,
            fs: this.fs,
            log: this.log,
          }, () => {
            this.onDidChangeEmitter.fire();
          });
    }
    await this.watcher.value?.registered;
    return this.discovery.discover(
      await configuredRoots(extraSkillDirs, workDirs, this.bootstrap.osHomeDir, 'extra', this.fs),
    );
  }
}
