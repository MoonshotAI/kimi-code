import type { LiveRef } from '#/_base/di/instantiation';
import { Event } from '#/_base/event';
import { agentProfileRegistryInContext } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import { LOCAL_ENVIRONMENT_ID, environmentBindingId, type EnvironmentBinding } from '#/environment/environment';
import { ExplicitFileSkillSource, type IExplicitFileSkillSource } from '#/features/skill/workspace/explicitFileSkillSource';
import { ExtraFileSkillSource, type IExtraFileSkillSource } from '#/features/skill/workspace/extraFileSkillSource';
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
import { workDirToPin } from '#/session/workspaceContext/workspaceRoots';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import { WorkspaceFsService } from '#/workspace/workspaceFs/fsService';
import type { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';
import { WorkspaceGitService } from '#/workspace/workspaceGit/workspaceGitService';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { WorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructionsService';
import type { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import { ExplicitAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoaderService';
import type { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import { ExtraAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoaderService';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import type { IWorkspaceTrustDisclosure } from '#/workspace/workspaceTrust/trustDisclosure';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { WorkspaceAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoaderService';

import type { ProgramDependencies } from './programDependencies';

export interface ProgramHarness {
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly pluginSkills: IPluginSkillSource;
}

export interface ProgramConfiguredSources {
  readonly contextKey: string;
  readonly explicitSkills: IExplicitFileSkillSource;
  readonly extraSkills: IExtraFileSkillSource;
  readonly explicitAgentProfiles: IExplicitAgentProfileLoader;
  readonly extraAgentProfiles: IExtraAgentProfileLoader;
}

export interface ProgramDirs {
  readonly state: IWorkspaceStateService;
  readonly localConfig: FileProjectLocalConfigService;
  readonly dirs: IWorkspaceDirs;
}

export interface ProgramView {
  readonly localConfig: FileProjectLocalConfigService;
  readonly hostFs: IHostFileSystem;
  readonly dirs: IWorkspaceDirs;
  readonly git: IWorkspaceGitService;
  readonly fs: IWorkspaceFsService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  readonly configuredSources: ProgramConfiguredSources;
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
  readonly configuredSources: ProgramConfiguredSources;
  dispose(): void;
}

export interface ProgramDisclosedWorkdir extends ProgramWorkdir {
  readonly trustDisclosure: IWorkspaceTrustDisclosure;
}

export const PROGRAM_CAPABILITIES = ['fs', 'process'] as const;

type Disposable = { dispose(): void | Promise<void> };
type Own = <T extends Disposable>(value: T) => T;

interface WorkdirBinding extends EnvironmentBinding {
  readonly cwd: string;
  readonly followsPrimary: boolean;
  readonly launchDir?: string;
}

interface ProgramWorkdirEntry {
  readonly view: ProgramView;
  readonly disposables: readonly Disposable[];
  references: number;
}

interface ProgramViewInput extends ProgramHarness {
  readonly context: IWorkspaceContext;
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
  readonly project: ProgramDirs;
  private readonly rootBinding: WorkdirBinding;
  private readonly rootKey: string;
  private readonly entries = new Map<string, ProgramWorkdirEntry>();
  private rootLease?: ProgramWorkdir;

  constructor(
    private readonly environments: IEnvironmentService,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
    private readonly harness: ProgramHarness,
    ownProject: Own,
  ) {
    this.rootBinding = { environmentId: LOCAL_ENVIRONMENT_ID, cwd: context.cwd, followsPrimary: true };
    this.rootKey = workdirContextKey(this.rootBinding);
    this.project = this.buildDirs(ownProject, this.viewInput(this.rootBinding));
  }

  get root(): ProgramView {
    this.rootLease ??= this.open(this.rootBinding);
    return this.openedRoot!;
  }

  get openedRoot(): ProgramView | undefined {
    return this.entries.get(this.rootKey)?.view;
  }

  async acquire(
    environmentId: string,
    cwd: string,
    followsPrimary = environmentId === LOCAL_ENVIRONMENT_ID,
    launchDir?: string,
  ): Promise<ProgramWorkdir> {
    const binding = this.bindingOf(environmentId, cwd, followsPrimary, launchDir);
    const stale = !watchable(environmentId) && this.entries.has(workdirContextKey(binding));
    const workdir = this.open(binding);
    if (stale) {
      try {
        await reloadView(workdir);
      } catch (error) {
        workdir.dispose();
        throw error;
      }
    }
    return workdir;
  }

  private bindingOf(environmentId: string, cwd: string, followsPrimary: boolean, launchDir: string | undefined): WorkdirBinding {
    if (environmentId === LOCAL_ENVIRONMENT_ID || launchDir === undefined) return { environmentId, cwd, followsPrimary };
    return { environmentId, cwd, followsPrimary, launchDir: workDirToPin(launchDir, this.context.meta.root) };
  }

  private open(binding: WorkdirBinding): ProgramWorkdir {
    const contextKey = workdirContextKey(binding);
    let entry = this.entries.get(contextKey);
    if (entry === undefined) {
      const disposables: Disposable[] = [];
      const own: Own = (value) => {
        disposables.push(value);
        return value;
      };
      try {
        entry = { view: this.build(own, binding), disposables, references: 0 };
      } catch (error) {
        disposeAll(disposables);
        throw error;
      }
      this.entries.set(contextKey, entry);
    }
    const acquired = entry;
    acquired.references += 1;
    let released = false;
    return {
      contextKey,
      hostFs: acquired.view.hostFs,
      localConfig: acquired.view.localConfig,
      dirs: acquired.view.dirs,
      fs: acquired.view.fs,
      instructions: acquired.view.instructions,
      skills: acquired.view.skills,
      agentProfiles: acquired.view.agentProfiles,
      configuredSources: acquired.view.configuredSources,
      dispose: () => {
        if (released) return;
        released = true;
        acquired.references -= 1;
        if (acquired.references > 0 || this.entries.get(contextKey) !== acquired) return;
        this.entries.delete(contextKey);
        disposeAll(acquired.disposables);
      },
    };
  }

  async reload({ environmentId = LOCAL_ENVIRONMENT_ID, cwd }: Partial<EnvironmentBinding>, launchDir?: string): Promise<void> {
    const followsPrimary = environmentId === LOCAL_ENVIRONMENT_ID && cwd === undefined;
    const requested = workdirContextKey(this.bindingOf(environmentId, cwd ?? this.context.cwd, followsPrimary, launchDir));
    for (const [contextKey, { view }] of this.entries) {
      try {
        await reloadView(view);
      } catch (error) {
        if (contextKey === requested) throw error;
        this.dependencies.log.warn('workdir reload failed', { workDir: view.dirs.primary, error: String(error) });
      }
    }
  }

  dispose(): void {
    const entries = [...this.entries.values()].toReversed();
    this.entries.clear();
    for (const entry of entries) disposeAll(entry.disposables);
  }

  private build(own: Own, binding: WorkdirBinding): ProgramView {
    const input = this.viewInput(binding);
    const dirs = input.contextKey === this.rootKey ? this.project : this.buildDirs(own, input);
    const launch = binding.environmentId === LOCAL_ENVIRONMENT_ID ? undefined : own(this.openLaunchDir(binding.launchDir));
    return this.buildView(own, input, dirs, launch?.configuredSources);
  }

  private openLaunchDir(launchDir: string | undefined): ProgramWorkdir {
    return this.open(launchDir === undefined
      ? this.rootBinding
      : { environmentId: LOCAL_ENVIRONMENT_ID, cwd: launchDir, followsPrimary: false });
  }

  private viewInput(binding: WorkdirBinding): ProgramViewInput {
    const { environmentId, cwd, followsPrimary } = binding;
    const lease = this.environments.acquire({ environmentId }, PROGRAM_CAPABILITIES);
    try {
      const hostFs = lease.environment.fs!;
      const local = this.environments.inspect({ environmentId: LOCAL_ENVIRONMENT_ID });
      const inProcess = watchable(environmentId);
      const trustCovered = environmentId === LOCAL_ENVIRONMENT_ID;
      return {
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
        contextKey: workdirContextKey(binding),
        userAgentProfiles: this.harness.userAgentProfiles,
        pluginSkills: this.harness.pluginSkills,
      };
    } finally {
      lease.dispose();
    }
  }

  private buildDirs(own: Own, input: ProgramViewInput): ProgramDirs {
    const state = own(new WorkspaceStateService(this.dependencies.appState));
    const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, input.hostFs, input.homeDir);
    const dirs = own(new WorkspaceDirsService(input.context, localConfig, this.dependencies.workspaces, this.dependencies.workspaceStore, this.dependencies.log, state, input.environmentId, input.followsPrimary));
    return { state, localConfig, dirs };
  }

  private buildView(
    own: Own,
    input: ProgramViewInput,
    { localConfig, dirs }: ProgramDirs,
    launchSources: ProgramConfiguredSources | undefined,
  ): ProgramView {
    const state = own(new WorkspaceStateService(this.dependencies.appState));
    const git = new WorkspaceGitService(dirs, input.git);
    const fs = new WorkspaceFsService(input.context, dirs, input.hostFs, this.environments, this.dependencies.telemetry, git, input.environmentId);
    const instructions = own(new WorkspaceInstructionsService(dirs, input.hostFs, input.instructionsHost, this.dependencies.bootstrap, this.dependencies.log, state, input.personalFs, input.watch));
    const agentProfiles: IWorkspaceAgentProfileLoader = input.projectAgentProfiles
      ? own(new WorkspaceAgentProfileLoaderService(input.context, input.hostFs, dirs, this.dependencies.log, input.userAgentProfiles, agentProfileRegistryInContext(this.dependencies.agentProfiles, input.contextKey), input.watch))
      : { _serviceBrand: undefined, ready: Promise.resolve(), reload: () => Promise.resolve() };
    const configuredSources = launchSources ?? this.buildConfiguredSources(own, input, dirs);
    const workspaceSkills = own(new WorkspaceRootSkillSource(new EnvironmentSkillDiscovery(this.dependencies.log, input.hostFs), input.context, this.dependencies.config, this.dependencies.bootstrap, dirs, input.hostFs, this.dependencies.log, input.watch));
    const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, this.dependencies.userSkills, configuredSources.explicitSkills, configuredSources.extraSkills, workspaceSkills, input.pluginSkills, state, this.dependencies.log));
    return { localConfig, hostFs: input.hostFs, dirs, git, fs, instructions, skills, agentProfiles, configuredSources };
  }

  private buildConfiguredSources(own: Own, input: ProgramViewInput, dirs: IWorkspaceDirs): ProgramConfiguredSources {
    const { bootstrap, config, log } = this.dependencies;
    const contextKey = configuredSourcesContextKey(input.contextKey);
    const agentProfiles = agentProfileRegistryInContext(this.dependencies.agentProfiles, contextKey);
    const discovery = new EnvironmentSkillDiscovery(log, input.hostFs);
    return {
      contextKey,
      explicitSkills: own(new ExplicitFileSkillSource(discovery, input.context, bootstrap, input.hostFs, log)),
      extraSkills: own(new ExtraFileSkillSource(discovery, config, input.context, bootstrap, input.hostFs, log)),
      explicitAgentProfiles: own(new ExplicitAgentProfileLoaderService(input.context, dirs, bootstrap, input.hostFs, log, input.userAgentProfiles, agentProfiles)),
      extraAgentProfiles: own(new ExtraAgentProfileLoaderService(config, input.context, dirs, bootstrap, input.hostFs, log, input.userAgentProfiles, agentProfiles)),
    };
  }
}

export function configuredSourcesContextKey(contextKey: string): string {
  return `${contextKey}\0configured-sources`;
}

function workdirContextKey({ environmentId, cwd, followsPrimary, launchDir }: WorkdirBinding): string {
  const base = environmentBindingId(environmentId, cwd);
  if (launchDir !== undefined) return `${base}\0launched\0${launchDir}`;
  return environmentId === LOCAL_ENVIRONMENT_ID && !followsPrimary ? `${base}\0pinned` : base;
}

function watchable(environmentId: string): boolean {
  return environmentId === LOCAL_ENVIRONMENT_ID;
}

async function reloadView(view: Pick<ProgramView, 'dirs' | 'instructions' | 'skills' | 'agentProfiles'>): Promise<void> {
  await view.dirs.reload();
  await view.instructions.reload();
  await view.skills.reload();
  await view.agentProfiles.reload().catch(() => undefined);
}

function disposeAll(disposables: readonly Disposable[]): void {
  for (const disposable of disposables.toReversed()) void disposable.dispose();
}
