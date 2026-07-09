/**
 * `sessionSkillCatalog` domain (L3) — workspace `ISkillSource` producer.
 *
 * Discovers project skills from the session's current `workDir`
 * (`workspaceContext`) through `ISkillDiscovery`, contributing them at priority
 * 20 (above user and plugin). Bound at Session scope so each session reads
 * its own workspace root.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { projectRoots } from '#/app/skillCatalog/skillRoots';
import type { ISkillSource, SkillContribution } from '#/app/skillCatalog/skillSource';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IWorkspaceFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IWorkspaceFileSkillSource: ServiceIdentifier<IWorkspaceFileSkillSource> =
  createDecorator<IWorkspaceFileSkillSource>('workspaceFileSkillSource');

export class WorkspaceFileSkillSource implements IWorkspaceFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'workspace';
  readonly priority = 20;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
  ) {}

  async load(): Promise<SkillContribution> {
    return this.discovery.discover(await projectRoots(this.workspace.workDir));
  }
}

registerScopedService(
  LifecycleScope.Session,
  IWorkspaceFileSkillSource,
  WorkspaceFileSkillSource,
  InstantiationType.Delayed,
  'sessionSkillCatalog',
);
