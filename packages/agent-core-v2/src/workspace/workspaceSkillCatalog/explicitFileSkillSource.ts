/**
 * `workspaceSkillCatalog` domain (L3) — explicit `ISkillSource` producer.
 *
 * Mirrors v1 SDK `skillDirs`: when runtime options provide `explicitDirs`, this
 * source contributes those directories as the user source, resolving relative
 * paths against the workspace root. When no explicit dirs are configured,
 * it yields nothing so default user / project discovery remains active. Bound
 * at Workspace scope so every session of the handler shares one scan.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { configuredRoots } from '#/app/skillCatalog/skillRoots';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import {
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
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
    @ISkillCatalogRuntimeOptions private readonly runtimeOptions: ISkillCatalogRuntimeOptions,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async load(): Promise<SkillContribution> {
    const explicitDirs = this.runtimeOptions.explicitDirs ?? [];
    if (explicitDirs.length === 0) {
      return { skills: [] };
    }
    return this.discovery.discover(
      await configuredRoots(explicitDirs, this.workspace.cwd, this.bootstrap.osHomeDir, 'user'),
    );
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IExplicitFileSkillSource,
  ExplicitFileSkillSource,
  ScopeActivation.OnScopeCreated,
  'workspaceSkillCatalog',
);
