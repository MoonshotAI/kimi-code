import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from '#/features/skill/catalog/configSection';
import { ISkillDiscovery } from '#/features/skill/catalog/skillDiscovery';
import {
  projectRootsForDirs,
  projectSkillRootCandidates,
} from '#/features/skill/catalog/skillRoots';
import {
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/features/skill/catalog/skillSource';
import type { ILogService } from '#/_base/log/log';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { watchCandidates } from '#human/utils/watch';

export const WORKSPACE_ROOT_SKILL_SOURCE_ID = 'workspace';

const WATCH_DEBOUNCE_MS = 200;

export interface IWorkspaceRootSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IWorkspaceRootSkillSource: ServiceIdentifier<IWorkspaceRootSkillSource> =
  createDecorator<IWorkspaceRootSkillSource>('workspaceRootSkillSource');

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
    @IWorkspaceDirs private readonly workspaceDirs: IWorkspaceDirs,
    private readonly fs: IHostFileSystem,
    private readonly log?: ILogService,
    private readonly watchEnabled = true,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
    this._register(
      this.workspaceDirs.onDidChange(() => {
        this.onDidChangeEmitter.fire();
      }),
    );
    this.watchReady = this.workspaceDirs.ready
      .then(() => this.updateProjectSkillRootWatches([]))
      .then(() => undefined);
  }

  private get workDirs(): readonly string[] {
    const primary =
      this.workspaceDirs.primaryByWorkspace[this.workspace.workspaceId] ?? this.workspace.cwd;
    return [primary, this.workspace.cwd, ...this.workspaceDirs.sharedAdditionalDirs];
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
        await projectRootsForDirs(this.workDirs, { mergeAllAvailableSkills }, this.fs),
      );
    let contribution = await discover();
    while (await this.updateProjectSkillRootWatches(contribution.scannedDirectories)) {
      contribution = await discover();
    }
    return contribution;
  }

  private async updateProjectSkillRootWatches(
    scannedDirectories: readonly string[],
  ): Promise<boolean> {
    if (!this.watchEnabled) return false;
    const watches = new Map<string, readonly string[]>();
    for (const workDir of this.workDirs) {
      const { projectRoot, candidates } = await projectSkillRootCandidates(workDir, this.fs);
      if (!watches.has(projectRoot)) watches.set(projectRoot, candidates);
    }
    const signature = JSON.stringify({
      watches: [...watches],
      scannedDirectories: [...scannedDirectories].toSorted(),
    });
    if (signature === this.watchSignature) return false;
    const resources = this.watchResources.add(new DisposableStore());
    try {
      for (const [projectRoot, candidates] of watches) {
        try {
          const handle = watchCandidates(projectRoot, candidates, {
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
          await handle.ready;
        } catch (error) {
          this.log?.warn(`project skill watcher failed for ${projectRoot}: ${String(error)}`);
        }
      }
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

