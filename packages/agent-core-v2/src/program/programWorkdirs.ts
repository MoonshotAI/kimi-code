import type { IDisposable } from '#/_base/di/lifecycle';
import type { LiveRef } from '#/_base/di/instantiation';
import { directoryKey } from '#/_base/utils/paths';
import { Event } from '#/_base/event';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import { LOCAL_ENVIRONMENT_ID, environmentBindingId } from '#/environment/environment';
import { ExplicitFileSkillSource } from '#/features/skill/workspace/explicitFileSkillSource';
import { ExtraFileSkillSource } from '#/features/skill/workspace/extraFileSkillSource';
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
import { ExplicitAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoaderService';
import { ExtraAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoaderService';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { WorkspaceAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoaderService';

import { WorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcpService';
import type { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { WorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfigService';
import type { IWorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import type { IWorkspaceTrustDisclosure } from '#/workspace/workspaceTrust/trustDisclosure';
import { WorkspaceTrustDisclosureService } from '#/workspace/workspaceTrust/trustDisclosureService';

import type { ProgramDependencies } from './programDependencies';

export interface ProgramHarness {
  readonly trust: IWorkspaceTrust;
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly pluginSkills: IPluginSkillSource;
}

export interface ProgramView {
  readonly state: IWorkspaceStateService;
  readonly mcp: IWorkspaceMcpService;
  readonly mcpConfig: IWorkspaceMcpConfigService;
  readonly trustDisclosure: IWorkspaceTrustDisclosure;
  readonly localConfig: FileProjectLocalConfigService;
  readonly hostFs: IHostFileSystem;
  readonly dirs: IWorkspaceDirs;
  readonly git: IWorkspaceGitService;
  readonly fs: IWorkspaceFsService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
}

export interface ProgramWorkdir extends Omit<ProgramView, 'state'> {
  readonly contextKey: string;
  dispose(): void;
}

export const PROGRAM_CAPABILITIES = ['fs', 'process'] as const;

type Disposable = { dispose(): void | Promise<void> };
type Own = <T extends Disposable>(value: T) => T;

interface ProgramWorkdirEntry {
  readonly key: string;
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
  readonly personalFs: IHostFileSystem;
  readonly watch: boolean;
  readonly contextKey: string;
}

export class ProgramWorkdirs {
  private readonly entries = new Map<string, ProgramWorkdirEntry>();
  private readonly cleanups = new Set<Promise<void>>();
  private retainedRoot?: ProgramWorkdirEntry;
  private readonly projectSubscription?: IDisposable;

  constructor(
    private readonly environments: IEnvironmentService,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
    private readonly harness: ProgramHarness,
  ) {
    this.projectSubscription = context.onDidChangeProject?.(() => {
      const retained = this.retainedRoot;
      if (retained === undefined || retained.key === workdirContextKey(LOCAL_ENVIRONMENT_ID, context.meta.root)) return;
      this.retainedRoot = undefined;
      this.release(retained);
    });
  }

  get currentRoot(): ProgramView | undefined {
    return this.entries.get(workdirContextKey(LOCAL_ENVIRONMENT_ID, this.context.meta.root))?.view;
  }

  get root(): ProgramView {
    const entry = this.getEntry(LOCAL_ENVIRONMENT_ID, this.context.meta.root);
    if (entry !== this.retainedRoot) {
      if (this.retainedRoot !== undefined) this.release(this.retainedRoot);
      this.retainedRoot = entry;
      entry.references += 1;
    }
    return entry.view;
  }

  async acquire(environmentId: string, cwd: string, generation?: IDisposable): Promise<ProgramWorkdir> {
    const entry = this.getEntry(environmentId, cwd);
    const stale = entry.references > 0 && !watchable(environmentId);
    entry.references += 1;
    let released = false;
    const workdir: ProgramWorkdir = {
      contextKey: entry.key,
      hostFs: entry.view.hostFs,
      localConfig: entry.view.localConfig,
      dirs: entry.view.dirs,
      git: entry.view.git,
      fs: entry.view.fs,
      instructions: entry.view.instructions,
      skills: entry.view.skills,
      agentProfiles: entry.view.agentProfiles,
      get mcp() { return entry.view.mcp; },
      get mcpConfig() { return entry.view.mcpConfig; },
      trustDisclosure: entry.view.trustDisclosure,
      dispose: () => {
        if (released) return;
        released = true;
        this.release(entry);
        generation?.dispose();
      },
    };
    if (stale) {
      try {
        await reloadView(entry.view);
      } catch (error) {
        workdir.dispose();
        throw error;
      }
    }
    return workdir;
  }

  private getEntry(environmentId: string, cwd: string): ProgramWorkdirEntry {
    const key = workdirContextKey(environmentId, cwd);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const disposables: Disposable[] = [];
    const own: Own = (value) => {
      disposables.push(value);
      return value;
    };
    try {
      const view = this.build(own, environmentId, cwd);
      const entry = { key, view, disposables, references: 0 };
      this.entries.set(key, entry);
      return entry;
    } catch (error) {
      this.cleanup(disposables);
      throw error;
    }
  }

  private release(entry: ProgramWorkdirEntry): void {
    entry.references -= 1;
    if (entry.references > 0 || this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    this.cleanup(entry.disposables);
  }

  async reload(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.values()].map(({ view }) => reloadView(view)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  private cleanup(disposables: readonly Disposable[]): void {
    const cleanup = Promise.allSettled(disposables.toReversed().map(async (value) => value.dispose())).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') this.dependencies.log.error('workdir disposal failed', result.reason as unknown);
      }
    });
    this.cleanups.add(cleanup);
    void cleanup.finally(() => this.cleanups.delete(cleanup));
  }

  async dispose(): Promise<void> {
    this.projectSubscription?.dispose();
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.retainedRoot = undefined;
    for (const entry of entries) this.cleanup(entry.disposables);
    await Promise.all(this.cleanups);
  }

  private build(own: Own, environmentId: string, cwd: string): ProgramView {
    const lease = this.environments.acquire({ environmentId }, PROGRAM_CAPABILITIES);
    try {
      const hostFs = lease.environment.fs!;
      const local = this.environments.inspect({ environmentId: LOCAL_ENVIRONMENT_ID });
      const inProcess = watchable(environmentId);
      const project = this.context;
      return this.buildView(own, {
        context: { ...project, cwd, get meta() { return project.meta; } },
        hostFs,
        environmentId,
        trust: this.harness.trust,
        homeDir: lease.environment.host?.homeDir ?? '',
        git: inProcess
          ? this.dependencies.git
          : { current: new GitService(this.environments, hostFs, environmentId), onDidChange: Event.None as Event<void> },
        instructionsHost: local.host!,
        personalFs: local.fs!,
        watch: inProcess,
        contextKey: workdirContextKey(environmentId, cwd),
        userAgentProfiles: this.harness.userAgentProfiles,
        pluginSkills: this.harness.pluginSkills,
      });
    } finally {
      lease.dispose();
    }
  }

  private buildView(own: Own, input: ProgramViewInput): ProgramView {
    const state = own(new WorkspaceStateService(this.dependencies.appState));
    const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, input.hostFs, input.homeDir);
    const dirs = own(new WorkspaceDirsService(input.context, localConfig, this.dependencies.workspaces, this.dependencies.workspaceStore, this.dependencies.log, state, input.environmentId));
    const git = new WorkspaceGitService(dirs, input.git);
    const fs = new WorkspaceFsService(input.context, dirs, input.hostFs, this.environments, this.dependencies.telemetry, git, input.environmentId);
    const instructions = own(new WorkspaceInstructionsService(dirs, input.hostFs, input.instructionsHost, this.dependencies.bootstrap, this.dependencies.log, state, input.personalFs, input.watch));
    const { bootstrap, plugins, log, config, configStore, oauth, telemetry, identity } = this.dependencies;
    const local = input.environmentId === LOCAL_ENVIRONMENT_ID;
    const sourceContext = local ? input.context : { ...this.context, cwd: this.context.meta.root };
    const sourceDirs = local ? dirs : { primary: sourceContext.cwd, onDidChange: Event.None as Event<void> };
    const profileSources: IWorkspaceAgentProfileLoader[] = [
      own(new ExplicitAgentProfileLoaderService(sourceContext, sourceDirs, bootstrap, input.personalFs, log, input.userAgentProfiles, this.dependencies.agentProfiles, input.contextKey)),
      own(new ExtraAgentProfileLoaderService(config, sourceContext, sourceDirs, bootstrap, input.personalFs, log, input.userAgentProfiles, this.dependencies.agentProfiles, input.contextKey)),
    ];
    if (local) {
      profileSources.push(own(new WorkspaceAgentProfileLoaderService(input.context, input.hostFs, dirs, log, input.userAgentProfiles, this.dependencies.agentProfiles, input.contextKey, input.watch)));
    }
    const agentProfiles: IWorkspaceAgentProfileLoader = {
      _serviceBrand: undefined,
      get ready() { return Promise.all(profileSources.map((source) => source.ready)).then(() => undefined); },
      async reload() { await Promise.all(profileSources.map((source) => source.reload())); },
    };
    const hostDiscovery = new EnvironmentSkillDiscovery(log, input.personalFs);
    const explicitSkills = own(new ExplicitFileSkillSource(hostDiscovery, sourceContext, bootstrap, input.personalFs, log));
    const extraSkills = own(new ExtraFileSkillSource(hostDiscovery, config, sourceContext, bootstrap, input.personalFs, log));
    const workspaceSkills = own(new WorkspaceRootSkillSource(local ? hostDiscovery : new EnvironmentSkillDiscovery(log, input.hostFs), input.context, config, bootstrap, dirs, input.hostFs, log, input.watch));
    const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, this.dependencies.userSkills, explicitSkills, extraSkills, workspaceSkills, input.pluginSkills, state));
    const createMcpConfig = () => own(new WorkspaceMcpConfigService(dirs, bootstrap, plugins, log, config, input.hostFs, input.trust, configStore, oauth));
    const createMcp = () => {
      const service = new WorkspaceMcpService(dirs, this.environments, view.mcpConfig, oauth, log, telemetry, identity);
      own({ dispose: () => service.disposeAsync() });
      return service;
    };
    let hostEntry: ProgramWorkdirEntry | undefined;
    const hostMcp = (): ProgramView => {
      if (hostEntry !== undefined) return hostEntry.view;
      const entry = this.getEntry(LOCAL_ENVIRONMENT_ID, this.context.meta.root);
      entry.references += 1;
      own({ dispose: () => this.release(entry) });
      hostEntry = entry;
      return entry.view;
    };
    let mcpConfig: IWorkspaceMcpConfigService | undefined;
    let mcp: IWorkspaceMcpService | undefined;
    const trustDisclosure = new WorkspaceTrustDisclosureService(
      input.context, input.hostFs, bootstrap, config, localConfig, dirs, input.trust, skills,
      agentProfiles, this.dependencies.agentProfiles, instructions, log, input.contextKey,
      local ? undefined : () => ({
        fs: this.environments.inspect({ environmentId: LOCAL_ENVIRONMENT_ID }).fs!,
        cwd: hostEntry?.view.dirs.primary ?? this.context.meta.root,
      }),
    );
    const view: ProgramView = {
      state, localConfig, hostFs: input.hostFs, dirs, git, fs, instructions, skills, agentProfiles, trustDisclosure,
      get mcpConfig() { return local ? mcpConfig ??= createMcpConfig() : hostMcp().mcpConfig; },
      get mcp() { return local ? mcp ??= createMcp() : hostMcp().mcp; },
    };
    return view;
  }
}

function workdirContextKey(environmentId: string, cwd: string): string {
  return environmentBindingId(environmentId, environmentId === LOCAL_ENVIRONMENT_ID ? directoryKey(cwd) : cwd);
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
