import type { LiveRef } from '#/_base/di/instantiation';
import { Event } from '#/_base/event';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import { LOCAL_ENVIRONMENT_ID, environmentBindingId } from '#/environment/environment';
import type { IExplicitFileSkillSource } from '#/features/skill/workspace/explicitFileSkillSource';
import type { IExtraFileSkillSource } from '#/features/skill/workspace/extraFileSkillSource';
import type { IPluginSkillSource } from '#/features/skill/workspace/pluginSkillSource';
import { WorkspaceRootSkillSource } from '#/features/skill/workspace/rootFileSkillSource';
import { EnvironmentSkillDiscovery } from '#/features/skill/workspace/environmentSkillDiscovery';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import { WorkspaceSkillCatalogService } from '#/features/skill/workspace/workspaceSkillCatalogService';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import type { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import { WorkspaceFsService } from '#/workspace/workspaceFs/fsService';
import type { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';
import { WorkspaceGitService } from '#/workspace/workspaceGit/workspaceGitService';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { WorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructionsService';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { WorkspaceAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoaderService';

import type { ProgramDependencies } from './programDependencies';

export interface ProgramHarness {
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly explicitSkills: IExplicitFileSkillSource;
  readonly extraSkills: IExtraFileSkillSource;
  readonly pluginSkills: IPluginSkillSource;
}

export interface ProgramView {
  readonly state: IWorkspaceStateService;
  readonly localConfig: FileProjectLocalConfigService;
  readonly hostFs: IHostFileSystem;
  readonly dirs: IWorkspaceDirs;
  readonly git: IWorkspaceGitService;
  readonly fs: IWorkspaceFsService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
}

export interface ProgramWorkdir {
  readonly contextKey: string;
  readonly hostFs: IHostFileSystem;
  readonly localConfig: FileProjectLocalConfigService;
  readonly dirs: IWorkspaceDirs;
  readonly fs: IWorkspaceFsService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  dispose(): void;
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
  readonly context: IWorkspaceContext;
  readonly hostFs: IHostFileSystem;
  readonly environmentId: string;
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
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
    private readonly harness: ProgramHarness,
    ownRoot: Own,
  ) {
    this.root = this.build(ownRoot, LOCAL_ENVIRONMENT_ID, context.cwd);
    this.entries.set(environmentBindingId(LOCAL_ENVIRONMENT_ID, context.cwd), { view: this.root, disposables: [], references: 1 });
  }

  async acquire(environmentId: string, cwd: string): Promise<ProgramWorkdir> {
    const contextKey = environmentBindingId(environmentId, cwd);
    let entry = this.entries.get(contextKey);
    const stale = entry !== undefined && !watchable(environmentId);
    if (entry === undefined) {
      const disposables: Disposable[] = [];
      const own: Own = (value) => {
        disposables.push(value);
        return value;
      };
      try {
        entry = { view: this.build(own, environmentId, cwd), disposables, references: 0 };
      } catch (error) {
        disposeAll(disposables);
        throw error;
      }
      this.entries.set(contextKey, entry);
    }
    const acquired = entry;
    acquired.references += 1;
    let released = false;
    const workdir: ProgramWorkdir = {
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

  private build(own: Own, environmentId: string, cwd: string): ProgramView {
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
        homeDir: lease.environment.host?.homeDir ?? '',
        git: inProcess
          ? this.dependencies.git
          : { current: new GitService(this.environments, hostFs, environmentId), onDidChange: Event.None as Event<void> },
        instructionsHost: local.host!,
        personalFs: local.fs,
        watch: inProcess,
        projectAgentProfiles: trustCovered,
        contextKey: environmentBindingId(environmentId, cwd),
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
    const state = own(new WorkspaceStateService(this.dependencies.appState));
    const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, input.hostFs, input.homeDir);
    const dirs = own(new WorkspaceDirsService(input.context, localConfig, this.dependencies.workspaces, this.dependencies.workspaceStore, this.dependencies.log, state));
    const git = new WorkspaceGitService(input.context, input.git);
    const fs = new WorkspaceFsService(input.context, dirs, input.hostFs, this.environments, this.dependencies.telemetry, git, input.environmentId);
    const instructions = own(new WorkspaceInstructionsService(input.context, input.hostFs, input.instructionsHost, this.dependencies.bootstrap, this.dependencies.log, state, input.personalFs, input.watch));
    const agentProfiles: IWorkspaceAgentProfileLoader = input.projectAgentProfiles
      ? own(new WorkspaceAgentProfileLoaderService(input.context, input.hostFs, this.dependencies.log, input.userAgentProfiles, this.dependencies.agentProfiles, input.contextKey, input.watch))
      : { _serviceBrand: undefined, ready: Promise.resolve(), reload: () => Promise.resolve() };
    const workspaceSkills = own(new WorkspaceRootSkillSource(new EnvironmentSkillDiscovery(this.dependencies.log, input.hostFs), input.context, this.dependencies.config, this.dependencies.bootstrap, dirs, input.hostFs, this.dependencies.log, input.watch));
    const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, this.dependencies.userSkills, input.explicitSkills, input.extraSkills, workspaceSkills, input.pluginSkills, state));
    return { state, localConfig, hostFs: input.hostFs, dirs, git, fs, instructions, skills, agentProfiles };
  }
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
