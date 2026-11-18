import type { IExplicitFileSkillSource } from '#/features/skill/workspace/explicitFileSkillSource';
import type { IExtraFileSkillSource } from '#/features/skill/workspace/extraFileSkillSource';
import type { IPluginSkillSource } from '#/features/skill/workspace/pluginSkillSource';
import { WorkspaceRootSkillSource } from '#/features/skill/workspace/rootFileSkillSource';
import { EnvironmentSkillDiscovery } from '#/features/skill/workspace/environmentSkillDiscovery';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import { WorkspaceSkillCatalogService } from '#/features/skill/workspace/workspaceSkillCatalogService';
import { IHostEnvironment, type HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
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
  readonly git: IWorkspaceGitService;
  readonly fs: IWorkspaceFsService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  dispose(): void;
}

type Disposable = { dispose(): void | Promise<void> };
type Own = <T extends Disposable>(value: T) => T;

interface ProgramWorkdirEntry {
  readonly view: ProgramView;
  readonly disposables: readonly Disposable[];
  references: number;
}

interface ProgramViewInput extends ProgramHarness {
  readonly context: IWorkspaceContext;
  readonly followsPrimary: boolean;
  readonly homeDir: string;
  readonly instructionsHost: HostEnvironmentInfo;
  readonly contextKey: string;
}

export class ProgramWorkdirs {
  readonly root: ProgramView;
  private readonly entries = new Map<string, ProgramWorkdirEntry>();

  constructor(
    private readonly hostFs: IHostFileSystem,
    private readonly process: IHostProcessService,
    private readonly environment: IHostEnvironment,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
    private readonly harness: ProgramHarness,
    ownRoot: Own,
  ) {
    this.root = this.build(ownRoot, context.cwd, true);
    this.entries.set(workdirContextKey(context.cwd, true), { view: this.root, disposables: [], references: 1 });
  }

  async acquire(cwd: string, followsPrimary = true): Promise<ProgramWorkdir> {
    const contextKey = workdirContextKey(cwd, followsPrimary);
    let entry = this.entries.get(contextKey);
    if (entry === undefined) {
      const disposables: Disposable[] = [];
      const own: Own = (value) => {
        disposables.push(value);
        return value;
      };
      try {
        entry = { view: this.build(own, cwd, followsPrimary), disposables, references: 0 };
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
      git: acquired.view.git,
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
  }

  async reload(): Promise<void> {
    for (const { view } of this.entries.values()) await reloadView(view);
  }

  dispose(): void {
    for (const entry of [...this.entries.values()].toReversed()) disposeAll(entry.disposables);
    this.entries.clear();
  }

  private build(own: Own, cwd: string, followsPrimary: boolean): ProgramView {
    return this.buildView(own, {
      context: { ...this.context, cwd },
      followsPrimary,
      homeDir: this.environment.homeDir,
      instructionsHost: this.environment,
      contextKey: workdirContextKey(cwd, followsPrimary),
      userAgentProfiles: this.harness.userAgentProfiles,
      explicitSkills: this.harness.explicitSkills,
      extraSkills: this.harness.extraSkills,
      pluginSkills: this.harness.pluginSkills,
    });
  }

  private buildView(own: Own, input: ProgramViewInput): ProgramView {
    const state = own(new WorkspaceStateService(this.dependencies.appState));
    const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, this.hostFs, input.homeDir);
    const dirs = own(new WorkspaceDirsService(input.context, localConfig, this.dependencies.workspaces, this.dependencies.workspaceStore, this.dependencies.log, state, input.followsPrimary));
    const git = new WorkspaceGitService(dirs, this.dependencies.git);
    const fs = new WorkspaceFsService(input.context, dirs, this.hostFs, this.process, this.environment, this.dependencies.telemetry, git);
    const instructions = own(new WorkspaceInstructionsService(dirs, this.hostFs, input.instructionsHost, this.dependencies.bootstrap, this.dependencies.log, state, this.hostFs, true));
    const agentProfiles = own(new WorkspaceAgentProfileLoaderService(input.context, this.hostFs, dirs, this.dependencies.log, input.userAgentProfiles, this.dependencies.agentProfiles, input.contextKey, true));
    const workspaceSkills = own(new WorkspaceRootSkillSource(new EnvironmentSkillDiscovery(this.dependencies.log, this.hostFs), input.context, this.dependencies.config, this.dependencies.bootstrap, dirs, this.hostFs, this.dependencies.log, true));
    const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, this.dependencies.userSkills, input.explicitSkills, input.extraSkills, workspaceSkills, input.pluginSkills, state));
    return { state, localConfig, hostFs: this.hostFs, dirs, git, fs, instructions, skills, agentProfiles };
  }
}

function workdirContextKey(cwd: string, followsPrimary: boolean): string {
  return followsPrimary ? `local\0${cwd}` : `local\0${cwd}\0pinned`;
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
