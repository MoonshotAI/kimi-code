/**
 * `sessionSkillCatalog` domain (L3) — workspace `ISkillSource` producer.
 *
 * Discovers project skills from the session's current `workDir`
 * (`workspaceContext`) through `ISkillDiscovery`, contributing them at priority
 * 30 (above user / extra / plugin / builtin). Bound at Session scope so each session reads
 * its own workspace root.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from '#/app/skillCatalog/configSection';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { projectRoots } from '#/app/skillCatalog/skillRoots';
import { SKILL_SOURCE_PRIORITY, type ISkillSource, type SkillContribution } from '#/app/skillCatalog/skillSource';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IWorkspaceFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IWorkspaceFileSkillSource: ServiceIdentifier<IWorkspaceFileSkillSource> =
  createDecorator<IWorkspaceFileSkillSource>('workspaceFileSkillSource');

export class WorkspaceFileSkillSource extends Disposable implements IWorkspaceFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'workspace';
  readonly priority = SKILL_SOURCE_PRIORITY.workspace;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IConfigService private readonly config: IConfigService,
    @ISkillCatalogRuntimeOptions private readonly runtimeOptions: ISkillCatalogRuntimeOptions,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(): Promise<SkillContribution> {
    if ((this.runtimeOptions.explicitDirs?.length ?? 0) > 0) {
      return { skills: [] };
    }
    await this.config.ready;
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    return this.discovery.discover(await projectRoots(this.workspace.workDir, { mergeAllAvailableSkills }));
  }
}

registerScopedService(
  LifecycleScope.Session,
  IWorkspaceFileSkillSource,
  WorkspaceFileSkillSource,
  InstantiationType.Delayed,
  'sessionSkillCatalog',
);
