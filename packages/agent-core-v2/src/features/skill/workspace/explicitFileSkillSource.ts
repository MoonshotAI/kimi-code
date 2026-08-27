import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { configuredRoots } from '#/features/skill/catalog/skillRoots';
import { ISkillDiscovery } from '#/features/skill/catalog/skillDiscovery';
import {
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/features/skill/catalog/skillSource';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

export interface IExplicitFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IExplicitFileSkillSource: ServiceIdentifier<IExplicitFileSkillSource> =
  createDecorator<IExplicitFileSkillSource>('explicitFileSkillSource');

export class ExplicitFileSkillSource implements IExplicitFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'explicit';
  readonly priority = SKILL_SOURCE_PRIORITY.user;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async load(): Promise<SkillContribution> {
    const explicitDirs = this.bootstrap.args.skillDirs ?? [];
    if (explicitDirs.length === 0) {
      return { skills: [] };
    }
    return this.discovery.discover(
      await configuredRoots(explicitDirs, this.workspace.cwd, this.bootstrap.osHomeDir, 'user'),
    );
  }
}

