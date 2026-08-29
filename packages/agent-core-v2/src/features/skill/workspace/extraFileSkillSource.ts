import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
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
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

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

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IConfigService private readonly config: IConfigService,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === EXTRA_SKILL_DIRS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(): Promise<SkillContribution> {
    await this.config.ready;
    const extraSkillDirs = this.config.get<ExtraSkillDirsConfig>(EXTRA_SKILL_DIRS_SECTION) ?? [];
    return this.discovery.discover(
      await configuredRoots(extraSkillDirs, this.workspace.cwd, this.bootstrap.osHomeDir, 'extra'),
    );
  }
}

