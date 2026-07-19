/**
 * `sessionSkillCatalog` domain (L3) — explicit `ISkillSource` producer.
 *
 * Mirrors v1 SDK `skillDirs`: when runtime options provide `explicitDirs`, this
 * source contributes those directories as the user source, resolving relative
 * paths against the session project root, and hot-reloads on filesystem
 * changes in them (watched through `hostFsWatch` via `SkillRootWatcher`). When
 * no explicit dirs are configured, it yields nothing so default user / project
 * discovery remains active. Bound at Session scope so each session resolves
 * paths against its own workDir.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { configuredRootCandidates, configuredRoots } from '#/app/skillCatalog/skillRoots';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { SkillRootWatcher } from '#/app/skillCatalog/skillRootWatcher';
import { SKILL_SOURCE_PRIORITY, type ISkillSource, type SkillContribution } from '#/app/skillCatalog/skillSource';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

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

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @ISkillCatalogRuntimeOptions private readonly runtimeOptions: ISkillCatalogRuntimeOptions,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFsWatchService hostFsWatch: IHostFsWatchService,
  ) {
    super();
    const explicitDirs = this.runtimeOptions.explicitDirs ?? [];
    if (explicitDirs.length > 0) {
      this._register(
        new SkillRootWatcher(
          hostFsWatch,
          async () =>
            configuredRootCandidates(explicitDirs, this.workspace.workDir, this.bootstrap.osHomeDir),
          () => this.onDidChangeEmitter.fire(),
        ),
      );
    }
  }

  async load(): Promise<SkillContribution> {
    const explicitDirs = this.runtimeOptions.explicitDirs ?? [];
    if (explicitDirs.length === 0) {
      return { skills: [] };
    }
    return this.discovery.discover(
      await configuredRoots(explicitDirs, this.workspace.workDir, this.bootstrap.osHomeDir, 'user'),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  IExplicitFileSkillSource,
  ExplicitFileSkillSource,
  InstantiationType.Eager,
  'sessionSkillCatalog',
);
