/**
 * `workspaceSkillCatalog` domain — workspace-root `ISkillSource`
 * producer.
 *
 * Discovers project skills from the handler's workspace root
 * (`workspaceContext.cwd`) through `ISkillDiscovery`, contributing them at
 * priority 30. Watches project skill-root candidates through `hostFsWatch`
 * and emits debounced invalidations for source reloads. Bound at Workspace
 * scope so every session of the handler shares one scan.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from '#/app/skillCatalog/configSection';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { projectRoots, projectSkillRootCandidates } from '#/app/skillCatalog/skillRoots';
import {
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

export const WORKSPACE_ROOT_SKILL_SOURCE_ID = 'workspace';

const WATCH_DEBOUNCE_MS = 200;

export interface IWorkspaceRootSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IWorkspaceRootSkillSource: ServiceIdentifier<IWorkspaceRootSkillSource> =
  createDecorator<IWorkspaceRootSkillSource>('workspaceRootSkillSource');

// NOTE: stays Disposable — its own 'config' collides with the Fiber
export class WorkspaceRootSkillSource extends Disposable implements IWorkspaceRootSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = WORKSPACE_ROOT_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.workspace;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchResources = this._register(new DisposableStore());
  private readonly watchReady: Promise<void>;
  private activeWatchResources: DisposableStore | undefined;
  private watchSignature: string | undefined;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
    this.watchReady = this.updateProjectSkillRootWatch([]).then(() => undefined);
  }

  async load(): Promise<SkillContribution> {
    await this.watchReady;
    if ((this.bootstrap.args.skillDirs?.length ?? 0) > 0) {
      return { skills: [] };
    }
    await this.config.ready;
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    const discover = async () =>
      this.discovery.discover(
        await projectRoots(this.workspace.cwd, { mergeAllAvailableSkills }),
      );
    let contribution = await discover();
    while (await this.updateProjectSkillRootWatch(contribution.scannedDirectories)) {
      contribution = await discover();
    }
    return contribution;
  }

  private async updateProjectSkillRootWatch(
    scannedDirectories: readonly string[],
  ): Promise<boolean> {
    const { projectRoot, candidates } = await projectSkillRootCandidates(this.workspace.cwd);
    const signature = [...scannedDirectories].toSorted().join('\0');
    if (signature === this.watchSignature) return false;
    const resources = this.watchResources.add(new DisposableStore());
    const handle = this.fsWatch.watch(projectRoot, {
      ignored: subtreeWatchFilter(projectRoot, candidates, {
        scannedDirectories,
        keepEntryFile: 'SKILL.md',
      }),
      signal: true,
    });
    resources.add(handle);
    resources.add(
      handle.onDidChange(() => {
        this.watchDebounce.cancelAndSet(() => this.onDidChangeEmitter.fire(), WATCH_DEBOUNCE_MS);
      }),
    );
    try {
      await handle.ready;
    } catch (error) {
      this.watchResources.delete(resources);
      throw error;
    }
    if (this.watchResources.isDisposed) return false;
    const previous = this.activeWatchResources;
    this.activeWatchResources = resources;
    this.watchSignature = signature;
    if (previous !== undefined) this.watchResources.delete(previous);
    return true;
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceRootSkillSource,
  WorkspaceRootSkillSource,
  ScopeActivation.OnScopeCreated,
  'workspaceSkillCatalog',
);
