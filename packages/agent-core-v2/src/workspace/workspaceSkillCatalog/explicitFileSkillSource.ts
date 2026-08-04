/**
 * `workspaceSkillCatalog` domain — explicit `ISkillSource` producer.
 *
 * Mirrors v1 SDK `skillDirs`: when the host invocation args provide
 * `skillDirs`, this source contributes those directories as the user source,
 * resolving relative paths against the workspace root. When no explicit dirs
 * are configured, it yields nothing so default user / project discovery
 * remains active. Watches the explicit directories (existing or not) through a
 * `SkillRootWatcher` and re-fires `onDidChange` on debounced fs changes. Bound
 * at Workspace scope so every session of the handler shares one scan.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { resolveConfiguredSkillRoots } from '#/app/skillCatalog/skillRoots';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { SkillRootWatcher } from '#/app/skillCatalog/skillRootWatch';
import {
  isSkillLoadAborted,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

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
  private readonly watcher: SkillRootWatcher;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFsWatchService hostFsWatch: IHostFsWatchService,
    @IHostFileSystem hostFs: IHostFileSystem,
  ) {
    super();
    this.watcher = this._register(
      new SkillRootWatcher(hostFsWatch, hostFs, () => {
        this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(signal?: AbortSignal): Promise<SkillContribution> {
    const explicitDirs = this.bootstrap.args.skillDirs ?? [];
    if (explicitDirs.length === 0) {
      return { skills: [] };
    }
    const resolution = await resolveConfiguredSkillRoots(
      explicitDirs,
      this.workspace.cwd,
      this.bootstrap.osHomeDir,
      'user',
    );
    if (isSkillLoadAborted(signal)) return { skills: [] };
    await this.watcher.setPaths(resolution.candidates);
    if (isSkillLoadAborted(signal)) return { skills: [] };
    return this.discovery.discover(resolution.roots, signal);
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IExplicitFileSkillSource,
  ExplicitFileSkillSource,
  ScopeActivation.OnScopeCreated,
  'workspaceSkillCatalog',
);
