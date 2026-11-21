import type { LiveRef } from '#/_base/di/instantiation';
import { Event } from '#/_base/event';
import { sameDir } from '#/_base/utils/workdir-slug';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import type { Project } from '#/app/project/project';
import { LOCAL_ENVIRONMENT_ID, environmentBindingId } from '#/environment/environment';
import type { IExplicitFileSkillSource } from '#/features/skill/project/explicitFileSkillSource';
import type { IExtraFileSkillSource } from '#/features/skill/project/extraFileSkillSource';
import type { IPluginSkillSource } from '#/features/skill/project/pluginSkillSource';
import { ProjectRootSkillSource } from '#/features/skill/project/rootFileSkillSource';
import { EnvironmentSkillDiscovery } from '#/features/skill/project/environmentSkillDiscovery';
import type { IProjectSkillCatalog } from '#/features/skill/project/projectSkillCatalog';
import { ProjectSkillCatalogService } from '#/features/skill/project/projectSkillCatalogService';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { ProjectStateService } from '#/project/state/projectStateService';
import type { IProjectStateService } from '#/project/state/projectState';
import type { IProjectContext } from '#/project/projectContext/projectContext';
import type { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { ProjectDirsService } from '#/project/projectDirs/projectDirsService';
import type { IProjectFsService } from '#/project/projectFs/fs';
import { ProjectFsService } from '#/project/projectFs/fsService';
import type { IProjectGitService } from '#/project/projectGit/projectGit';
import { ProjectGitService } from '#/project/projectGit/projectGitService';
import type { IProjectInstructionsService } from '#/project/projectInstructions/projectInstructions';
import { ProjectInstructionsService } from '#/project/projectInstructions/projectInstructionsService';
import type { IUserAgentProfileLoader } from '#/project/projectAgentProfileLoader/userAgentProfileLoader';
import type { IProjectTrustDisclosure } from '#/project/projectTrust/trustDisclosure';
import type { IProjectAgentProfileLoader } from '#/project/projectAgentProfileLoader/projectAgentProfileLoader';
import { ProjectAgentProfileLoaderService } from '#/project/projectAgentProfileLoader/projectAgentProfileLoaderService';
import type { WorkdirMcp } from '#/project/projectMcp/projectMcp';

import type { ProgramDependencies } from './programDependencies';

export interface ProgramHarness {
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly explicitSkills: IExplicitFileSkillSource;
  readonly extraSkills: IExtraFileSkillSource;
  readonly pluginSkills: IPluginSkillSource;
}

export interface ProgramView {
  readonly state: IProjectStateService;
  readonly localConfig: FileProjectLocalConfigService;
  readonly hostFs: IHostFileSystem;
  readonly dirs: IProjectDirs;
  readonly git: IProjectGitService;
  readonly fs: IProjectFsService;
  readonly instructions: IProjectInstructionsService;
  readonly skills: IProjectSkillCatalog;
  readonly agentProfiles: IProjectAgentProfileLoader;
}

export interface ProgramViewLease {
  readonly contextKey: string;
  readonly hostFs: IHostFileSystem;
  readonly localConfig: FileProjectLocalConfigService;
  readonly dirs: IProjectDirs;
  readonly fs: IProjectFsService;
  readonly instructions: IProjectInstructionsService;
  readonly skills: IProjectSkillCatalog;
  readonly agentProfiles: IProjectAgentProfileLoader;
  dispose(): void;
}

export interface ProgramWorkdir extends ProgramViewLease {
  readonly mcp: WorkdirMcp;
  readonly trustDisclosure: IProjectTrustDisclosure;
}

export const PROGRAM_CAPABILITIES = ['fs', 'process'] as const;

type Disposable = { dispose(): void | Promise<void> };
type Own = <T extends Disposable>(value: T) => T;

interface ProgramWorkdirEntry {
  readonly view: ProgramView;
  readonly disposables: readonly Disposable[];
  references: number;
}

interface ProgramViewInput extends ProgramHarness {
  readonly context: IProjectContext;
  readonly hostFs: IHostFileSystem;
  readonly environmentId: string;
  readonly followsPrimary: boolean;
  readonly homeDir?: string;
  readonly git: LiveRef<IGitService>;
  readonly instructionsHost: HostEnvironmentInfo;
  readonly personalFs?: IHostFileSystem;
  readonly watch: boolean;
  readonly projectAgentProfiles: boolean;
  readonly contextKey: string;
}

export class ProgramWorkdirs {
  readonly root: ProgramView;
  private readonly entries = new Map<string, ProgramWorkdirEntry>();

  constructor(
    private readonly environments: IEnvironmentService,
    private readonly context: IProjectContext,
    private readonly dependencies: ProgramDependencies,
    private readonly harness: ProgramHarness,
    ownRoot: Own,
  ) {
    this.root = this.build(ownRoot, LOCAL_ENVIRONMENT_ID, context.cwd, true);
    this.entries.set(this.rootKey, { view: this.root, disposables: [], references: 1 });
  }

  get rootKey(): string {
    return workdirContextKey(LOCAL_ENVIRONMENT_ID, this.context.cwd, true);
  }

  async acquire(environmentId: string, cwd: string, followsPrimary = environmentId === LOCAL_ENVIRONMENT_ID): Promise<ProgramViewLease> {
    const contextKey = workdirViewKey(environmentId, cwd, followsPrimary, { kind: this.context.meta.kind, root: this.context.cwd });
    let entry = this.entries.get(contextKey);
    const stale = entry !== undefined && !watchable(environmentId);
    if (entry === undefined) {
      const disposables: Disposable[] = [];
      const own: Own = (value) => {
        disposables.push(value);
        return value;
      };
      try {
        entry = { view: this.build(own, environmentId, cwd, followsPrimary), disposables, references: 0 };
      } catch (error) {
        disposeAll(disposables);
        throw error;
      }
      this.entries.set(contextKey, entry);
    }
    const acquired = entry;
    acquired.references += 1;
    let released = false;
    const workdir: ProgramViewLease = {
      contextKey,
      hostFs: acquired.view.hostFs,
      localConfig: acquired.view.localConfig,
      dirs: acquired.view.dirs,
      fs: acquired.view.fs,
      instructions: acquired.view.instructions,
      skills: acquired.view.skills,
      agentProfiles: acquired.view.agentProfiles,
      dispose: () => {
        if (released) return;
        released = true;
        acquired.references -= 1;
        if (acquired.references > 0 || this.entries.get(contextKey) !== acquired) return;
        this.entries.delete(contextKey);
        disposeAll(acquired.disposables);
      },
    };
    if (stale) {
      try {
        await reloadView(acquired.view);
      } catch (error) {
        workdir.dispose();
        throw error;
      }
    }
    return workdir;
  }

  async reload(): Promise<void> {
    for (const { view } of this.entries.values()) await reloadView(view);
  }

  dispose(): void {
    for (const entry of [...this.entries.values()].toReversed()) disposeAll(entry.disposables);
    this.entries.clear();
  }

  private build(own: Own, environmentId: string, cwd: string, followsPrimary: boolean): ProgramView {
    const lease = this.environments.acquire({ environmentId }, PROGRAM_CAPABILITIES);
    try {
      const hostFs = lease.environment.fs!;
      const local = this.environments.inspect({ environmentId: LOCAL_ENVIRONMENT_ID });
      const inProcess = watchable(environmentId);
      const trustCovered = environmentId === LOCAL_ENVIRONMENT_ID;
      return this.buildView(own, {
        context: { ...this.context, cwd },
        hostFs,
        environmentId,
        followsPrimary,
        homeDir: lease.environment.host?.homeDir ?? '',
        git: inProcess
          ? this.dependencies.git
          : { current: new GitService(this.environments, hostFs, environmentId), onDidChange: Event.None as Event<void> },
        instructionsHost: local.host!,
        personalFs: local.fs,
        watch: inProcess,
        projectAgentProfiles: trustCovered,
        contextKey: workdirContextKey(environmentId, cwd, followsPrimary),
        userAgentProfiles: this.harness.userAgentProfiles,
        explicitSkills: this.harness.explicitSkills,
        extraSkills: this.harness.extraSkills,
        pluginSkills: this.harness.pluginSkills,
      });
    } finally {
      lease.dispose();
    }
  }

  private buildView(own: Own, input: ProgramViewInput): ProgramView {
    const state = own(new ProjectStateService(this.dependencies.appState));
    const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, input.hostFs, input.homeDir);
    const dirs = own(new ProjectDirsService(input.context, localConfig, this.dependencies.workspaces, this.dependencies.workspaceStore, this.dependencies.log, state, input.environmentId, input.followsPrimary));
    const git = new ProjectGitService(dirs, input.git);
    const fs = new ProjectFsService(input.context, dirs, input.hostFs, this.environments, this.dependencies.telemetry, git, input.environmentId);
    const instructions = own(new ProjectInstructionsService(dirs, input.hostFs, input.instructionsHost, this.dependencies.bootstrap, this.dependencies.log, state, input.personalFs, input.watch));
    const agentProfiles: IProjectAgentProfileLoader = input.projectAgentProfiles
      ? own(new ProjectAgentProfileLoaderService(input.context, input.hostFs, dirs, this.dependencies.log, input.userAgentProfiles, this.dependencies.agentProfiles, input.contextKey, input.watch))
      : { _serviceBrand: undefined, ready: Promise.resolve(), reload: () => Promise.resolve() };
    const workspaceSkills = own(new ProjectRootSkillSource(new EnvironmentSkillDiscovery(this.dependencies.log, input.hostFs), input.context, this.dependencies.config, this.dependencies.bootstrap, dirs, input.hostFs, this.dependencies.log, input.watch));
    const skills = own(new ProjectSkillCatalogService(this.dependencies.builtinSkills, this.dependencies.userSkills, input.explicitSkills, input.extraSkills, workspaceSkills, input.pluginSkills, state));
    return { state, localConfig, hostFs: input.hostFs, dirs, git, fs, instructions, skills, agentProfiles };
  }
}

export function workdirViewKey(
  environmentId: string,
  cwd: string,
  followsPrimary: boolean,
  project: Pick<Project, 'kind' | 'root'>,
): string {
  const atImplicitRoot = environmentId === LOCAL_ENVIRONMENT_ID && project.kind === 'implicit' && sameDir(cwd, project.root);
  return atImplicitRoot
    ? workdirContextKey(LOCAL_ENVIRONMENT_ID, project.root, true)
    : workdirContextKey(environmentId, cwd, followsPrimary);
}

function workdirContextKey(environmentId: string, cwd: string, followsPrimary: boolean): string {
  const base = environmentBindingId(environmentId, cwd);
  return environmentId === LOCAL_ENVIRONMENT_ID && !followsPrimary ? `${base}\0pinned` : base;
}

function watchable(environmentId: string): boolean {
  return environmentId === LOCAL_ENVIRONMENT_ID;
}

async function reloadView(view: ProgramView): Promise<void> {
  await view.dirs.reload();
  await view.instructions.reload();
  await view.skills.reload();
  await view.agentProfiles.reload().catch(() => undefined);
}

function disposeAll(disposables: readonly Disposable[]): void {
  for (const disposable of disposables.toReversed()) void disposable.dispose();
}
