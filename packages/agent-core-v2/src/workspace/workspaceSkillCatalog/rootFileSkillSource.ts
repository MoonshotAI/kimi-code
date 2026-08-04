/**
 * `workspaceSkillCatalog` domain — workspace-root `ISkillSource`
 * producer.
 *
 * Discovers project skills from the handler's workspace root
 * (`workspaceContext.cwd`) through `ISkillDiscovery`, contributing them at
 * priority 30 (above user / extra / plugin / builtin). Watches the project
 * skill-root candidates (`.kimi-code/skills`, `.agents/skills` under the
 * project root, watched whether or not they exist yet) through
 * `hostFsWatch` and re-fires `onDidChange` debounced, so the catalog
 * re-scans THIS source only when project skill files change. The watch
 * mirrors the scanner's own pruning — `node_modules` / dot entries gate
 * recursion but their direct SKILL.md stays watched, and the depth cap is
 * the scanner's plus two segments (the skill directory and its SKILL.md)
 * — and runs in `signal` mode, so a fat skill subtree (e.g. a skill
 * bundling a runtime environment) does not cost one fs-watch fd per file.
 * Bound at Workspace scope so every session of the handler shares one scan.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from '#/app/skillCatalog/configSection';
import {
  MAX_SKILL_SCAN_DEPTH,
  isSkillScanExcludedEntry,
} from '#/app/skillCatalog/fileSkillDiscovery';
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

export class WorkspaceRootSkillSource extends Disposable implements IWorkspaceRootSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = WORKSPACE_ROOT_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.workspace;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchReady: Promise<void>;

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
    this.watchReady = this.watchProjectSkillRoots();
  }

  async load(): Promise<SkillContribution> {
    await this.watchReady;
    if ((this.bootstrap.args.skillDirs?.length ?? 0) > 0) {
      return { skills: [] };
    }
    await this.config.ready;
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    return this.discovery.discover(
      await projectRoots(this.workspace.cwd, { mergeAllAvailableSkills }),
    );
  }

  private async watchProjectSkillRoots(): Promise<void> {
    const { projectRoot, candidates } = await projectSkillRootCandidates(this.workspace.cwd);
    const handle = this.fsWatch.watch(projectRoot, {
      ignored: subtreeWatchFilter(projectRoot, candidates, {
        maxDepth: MAX_SKILL_SCAN_DEPTH + 2,
        skipEntry: isSkillScanExcludedEntry,
        keepEntryFile: 'SKILL.md',
      }),
      signal: true,
    });
    this._register(handle);
    this._register(
      handle.onDidChange(() => {
        this.watchDebounce.cancelAndSet(() => this.onDidChangeEmitter.fire(), WATCH_DEBOUNCE_MS);
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceRootSkillSource,
  WorkspaceRootSkillSource,
  ScopeActivation.OnScopeCreated,
  'workspaceSkillCatalog',
);
