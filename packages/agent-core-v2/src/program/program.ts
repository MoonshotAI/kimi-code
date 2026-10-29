import type { LiveRef } from '#/_base/di/instantiation';
import { Emitter, Event } from '#/_base/event';
import type { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import type { EnvironmentBinding } from '#/environment/environment';
import { LOCAL_ENVIRONMENT_ID, environmentBindingId } from '#/environment/environment';
import { EnvironmentError, type EnvironmentGenerationSnapshot, type EnvironmentRegistryChange } from '#/environment/environmentRegistry';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
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
import type { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { WorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcpService';
import type { IWorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import { WorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfigService';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { WorkspaceTrustService } from '#/workspace/workspaceTrust/workspaceTrustService';
import type { IWorkspaceTrustDisclosure } from '#/workspace/workspaceTrust/trustDisclosure';
import { WorkspaceTrustDisclosureService } from '#/workspace/workspaceTrust/trustDisclosureService';
import type { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import { ExtraAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoaderService';
import type { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import { ExplicitAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoaderService';
import type { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import { PluginAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoaderService';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { UserAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoaderService';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { WorkspaceAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoaderService';
import { ExplicitFileSkillSource, type IExplicitFileSkillSource } from '#/features/skill/workspace/explicitFileSkillSource';
import { ExtraFileSkillSource, type IExtraFileSkillSource } from '#/features/skill/workspace/extraFileSkillSource';
import { PluginSkillSource, type IPluginSkillSource } from '#/features/skill/workspace/pluginSkillSource';
import { WorkspaceRootSkillSource } from '#/features/skill/workspace/rootFileSkillSource';
import { EnvironmentSkillDiscovery } from '#/features/skill/workspace/environmentSkillDiscovery';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import { WorkspaceSkillCatalogService } from '#/features/skill/workspace/workspaceSkillCatalogService';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { ProgramDependencies } from './programDependencies';

export type ProgramStatus = 'preparing' | 'ready' | 'degraded';

export interface ProgramCatalogSnapshot {
  readonly skills: {
    readonly total: number;
    readonly invocable: number;
    readonly skipped: number;
  };
  readonly agentProfiles: number;
  readonly mcpServers: number;
}

export interface ProgramSourceProvenanceSnapshot {
  readonly skills: readonly {
    readonly source: string;
    readonly count: number;
  }[];
  readonly skillRoots: readonly string[];
  readonly agentProfiles: readonly {
    readonly sourceId: string;
    readonly priority: number;
    readonly profiles: readonly string[];
  }[];
  readonly instructionPaths: readonly string[];
  readonly mcpServers: readonly string[];
}

export interface ProgramSnapshot {
  readonly workspaceId: string;
  readonly binding: EnvironmentBinding;
  readonly status: ProgramStatus;
  readonly ready: boolean;
  readonly generation?: string;
  readonly trusted?: boolean;
  readonly catalog: ProgramCatalogSnapshot;
  readonly sources: ProgramSourceProvenanceSnapshot;
  readonly environments: readonly EnvironmentGenerationSnapshot[];
}

interface ProgramHarness {
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly explicitSkills: IExplicitFileSkillSource;
  readonly extraSkills: IExtraFileSkillSource;
  readonly pluginSkills: IPluginSkillSource;
}

interface ProgramWorkdirEntry {
  readonly view: ProgramView;
  readonly disposables: readonly { dispose(): void | Promise<void> }[];
  references: number;
}

interface ProgramGeneration extends ProgramHarness {
  readonly id: string;
  readonly root: ProgramView;
  readonly workdirs: Map<string, ProgramWorkdirEntry>;
  readonly mcpConfig: IWorkspaceMcpConfigService;
  readonly mcp: IWorkspaceMcpService;
  readonly trust: IWorkspaceTrust;
  readonly trustDisclosure: IWorkspaceTrustDisclosure;
  readonly pluginAgentProfiles: IPluginAgentProfileLoader;
  readonly explicitAgentProfiles: IExplicitAgentProfileLoader;
  readonly extraAgentProfiles: IExtraAgentProfileLoader;
  readonly disposables: readonly { dispose(): void | Promise<void> }[];
  ready: boolean;
  failed: boolean;
  references: number;
  retired: boolean;
}

export interface ProgramWorkdir {
  readonly contextKey: string;
  readonly dirs: IWorkspaceDirs;
  readonly fs: IWorkspaceFsService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  dispose(): void;
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

interface ProgramView {
  readonly state: IWorkspaceStateService;
  readonly localConfig: FileProjectLocalConfigService;
  readonly dirs: IWorkspaceDirs;
  readonly git: IWorkspaceGitService;
  readonly fs: IWorkspaceFsService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
}

const PROGRAM_CAPABILITIES = ['fs', 'process'] as const;

export class Program {
  readonly binding: EnvironmentBinding = Object.freeze({ environmentId: LOCAL_ENVIRONMENT_ID });
  private currentStatus: ProgramStatus = 'preparing';
  private readonly changeEmitter = new Emitter<ProgramSnapshot>();
  readonly onDidChange: Event<ProgramSnapshot> = this.changeEmitter.event;
  private readonly registrySubscription;
  private generation?: ProgramGeneration;
  private generationFailed = false;
  private disposed = false;
  private readonly generationCleanups = new Set<Promise<void>>();
  private resolveReady?: () => void;
  readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  constructor(
    readonly workspaceId: string,
    private readonly environments: IEnvironmentService,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
  ) {
    this.registrySubscription = environments.onDidChange((change) => this.onEnvironmentChange(change));
    this.reconcileGeneration();
  }

  get status(): ProgramStatus { return this.currentStatus; }
  get state(): IWorkspaceStateService { return this.requireGeneration().root.state; }
  get dirs(): IWorkspaceDirs { return this.requireGeneration().root.dirs; }
  get fs(): IWorkspaceFsService { return this.requireGeneration().root.fs; }
  get git(): IWorkspaceGitService { return this.requireGeneration().root.git; }
  get instructions(): IWorkspaceInstructionsService { return this.requireGeneration().root.instructions; }
  get mcpConfig(): IWorkspaceMcpConfigService { return this.requireGeneration().mcpConfig; }
  get mcp(): IWorkspaceMcpService { return this.requireGeneration().mcp; }
  get trust(): IWorkspaceTrust { return this.requireGeneration().trust; }
  get trustDisclosure(): IWorkspaceTrustDisclosure { return this.requireGeneration().trustDisclosure; }
  get skills(): IWorkspaceSkillCatalog { return this.requireGeneration().root.skills; }
  get agentProfiles(): IWorkspaceAgentProfileLoader { return this.requireGeneration().root.agentProfiles; }
  get userAgentProfiles(): IUserAgentProfileLoader { return this.requireGeneration().userAgentProfiles; }
  get sessionControllerGeneration(): string { return this.requireGeneration().id; }

  private get rootKey(): string {
    return environmentBindingId(LOCAL_ENVIRONMENT_ID, this.context.cwd);
  }

  createSessionController(): SessionLifecycleService {
    const generation = this.requireGeneration();
    generation.references += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.releaseGeneration(generation);
    };
    try {
      return this.dependencies.createSessionController({
        context: this.context,
        extraAgentProfiles: generation.extraAgentProfiles,
        explicitAgentProfiles: generation.explicitAgentProfiles,
        userAgentProfiles: generation.userAgentProfiles,
        pluginAgentProfiles: generation.pluginAgentProfiles,
        mcp: generation.mcp,
        acquireWorkdir: (environmentId, cwd) => this.acquireWorkdir(generation, environmentId, cwd),
        onDispose: release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  async reload(): Promise<void> {
    const generation = this.requireGeneration();
    for (const { view } of generation.workdirs.values()) await reloadView(view);
    await generation.userAgentProfiles.reload().catch(() => undefined);
  }

  snapshot(): ProgramSnapshot {
    const generation = this.generation;
    const skills = generation?.root.skills.catalog.listSkills() ?? [];
    const skillsBySource = new Map<string, number>();
    for (const skill of skills) {
      skillsBySource.set(skill.source, (skillsBySource.get(skill.source) ?? 0) + 1);
    }
    const rootKey = this.rootKey;
    const agentProfiles = this.dependencies.agentProfiles.entries()
      .filter((entry) =>
        (entry.workspaceKey === undefined || entry.workspaceKey === this.workspaceId) &&
        (entry.contextKey === undefined || entry.contextKey === rootKey),
      )
      .map((entry) => ({
        sourceId: entry.sourceId,
        priority: entry.priority,
        profiles: entry.contribution.profiles.map((profile) => profile.name),
      }));
    const mcpServers = Object.keys(generation?.mcpConfig.servers() ?? {});
    return {
      workspaceId: this.workspaceId,
      binding: this.binding,
      status: this.currentStatus,
      ready: generation?.ready === true,
      generation: generation?.id,
      trusted: generation?.trust.isTrusted(),
      catalog: {
        skills: {
          total: skills.length,
          invocable: generation?.root.skills.catalog.listInvocableSkills().length ?? 0,
          skipped: generation?.root.skills.catalog.getSkippedByPolicy().length ?? 0,
        },
        agentProfiles: agentProfiles.reduce((total, source) => total + source.profiles.length, 0),
        mcpServers: mcpServers.length,
      },
      sources: {
        skills: [...skillsBySource].map(([source, count]) => ({ source, count })),
        skillRoots: generation?.root.skills.catalog.getSkillRoots() ?? [],
        agentProfiles,
        instructionPaths: generation?.root.instructions.snapshot.agentsMdPaths ?? [],
        mcpServers,
      },
      environments: this.environments.snapshot().environments,
    };
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.registrySubscription.dispose();
      const generation = this.generation;
      this.generation = undefined;
      if (generation !== undefined) this.retireGeneration(generation);
      this.changeEmitter.dispose();
    }
    const settled = await Promise.allSettled(this.generationCleanups);
    const errors = settled
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `program ${this.workspaceId} disposal failed`);
  }

  private requireGeneration(): ProgramGeneration {
    if (this.generation === undefined) throw new Error(`program ${this.workspaceId} has no available local environment generation`);
    return this.generation;
  }

  private onEnvironmentChange(change: EnvironmentRegistryChange): void {
    if (change.environmentId !== LOCAL_ENVIRONMENT_ID || this.disposed) return;
    this.reconcileGeneration();
  }

  private reconcileGeneration(): void {
    const local = this.environments.current(LOCAL_ENVIRONMENT_ID);
    if (local === undefined) {
      const previous = this.generation;
      this.generation = undefined;
      if (previous !== undefined) this.retireGeneration(previous);
      this.refresh();
      return;
    }
    if (this.generation?.id !== local.identity.generation) {
      const previous = this.generation;
      this.generationFailed = false;
      try {
        const next = this.createGeneration();
        this.generation = next;
        if (previous !== undefined) this.retireGeneration(previous);
        this.observeReadiness(next);
      } catch (error) {
        if (!(error instanceof EnvironmentError && error.code === 'environment.unavailable')) {
          this.generationFailed = true;
          this.resolveProgramReady();
        }
      }
    }
    this.refresh();
  }

  private createGeneration(): ProgramGeneration {
    const lease = this.environments.acquire(this.binding, PROGRAM_CAPABILITIES);
    const environment = lease.environment;
    const disposables: { dispose(): void | Promise<void> }[] = [];
    const own = <T extends { dispose(): void | Promise<void> }>(value: T): T => {
      disposables.push(value);
      return value;
    };
    try {
      const hostFs = environment.fs!;
      const skillDiscovery = new EnvironmentSkillDiscovery(this.dependencies.log, hostFs);
      const explicitSkills = new ExplicitFileSkillSource(skillDiscovery, this.context, this.dependencies.bootstrap, hostFs);
      const extraSkills = own(new ExtraFileSkillSource(skillDiscovery, this.dependencies.config, this.context, this.dependencies.bootstrap, hostFs));
      const pluginSkills = new PluginSkillSource(skillDiscovery, this.dependencies.plugins);
      const userAgentProfiles = own(new UserAgentProfileLoaderService(this.dependencies.bootstrap, hostFs, this.dependencies.log, this.dependencies.builtinAgentProfiles, this.context, this.dependencies.agentProfiles));
      const pluginAgentProfiles = own(new PluginAgentProfileLoaderService(this.dependencies.plugins, hostFs, this.dependencies.log, userAgentProfiles, this.context, this.dependencies.agentProfiles));
      const explicitAgentProfiles = own(new ExplicitAgentProfileLoaderService(this.context, this.dependencies.bootstrap, hostFs, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const extraAgentProfiles = own(new ExtraAgentProfileLoaderService(this.dependencies.config, this.context, this.dependencies.bootstrap, hostFs, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const harness: ProgramHarness = { userAgentProfiles, explicitSkills, extraSkills, pluginSkills };
      const root = this.buildWorkdir(own, harness, LOCAL_ENVIRONMENT_ID, this.context.cwd);
      const trust = own(new WorkspaceTrustService(this.context, this.dependencies.trustStore, root.state));
      const mcpConfig = own(new WorkspaceMcpConfigService(this.context, this.dependencies.bootstrap, this.dependencies.plugins, this.dependencies.log, this.dependencies.config, hostFs, trust, this.dependencies.configStore));
      const mcp = new WorkspaceMcpService(this.context, this.environments, mcpConfig, this.dependencies.oauth, this.dependencies.log, this.dependencies.telemetry, this.dependencies.identity, this.dependencies.sessionManager);
      disposables.push({ dispose: () => mcp.disposeAsync() });
      const trustDisclosure = new WorkspaceTrustDisclosureService(this.context, hostFs, this.dependencies.bootstrap, this.dependencies.config, root.localConfig, trust, root.skills, root.agentProfiles, this.dependencies.agentProfiles, root.instructions, this.dependencies.log);
      const workdirs = new Map<string, ProgramWorkdirEntry>([[this.rootKey, { view: root, disposables: [], references: 1 }]]);
      own({
        dispose: () => {
          for (const entry of [...workdirs.values()].toReversed()) disposeAll(entry.disposables);
          workdirs.clear();
        },
      });
      return {
        id: environment.identity.generation,
        root,
        workdirs,
        mcpConfig,
        mcp,
        trust,
        trustDisclosure,
        ...harness,
        pluginAgentProfiles,
        explicitAgentProfiles,
        extraAgentProfiles,
        disposables,
        ready: false,
        failed: false,
        references: 1,
        retired: false,
      };
    } catch (error) {
      this.cleanupGeneration({ disposables });
      throw error;
    } finally {
      lease.dispose();
    }
  }

  private async acquireWorkdir(generation: ProgramGeneration, environmentId: string, cwd: string): Promise<ProgramWorkdir> {
    const contextKey = environmentBindingId(environmentId, cwd);
    let entry = generation.workdirs.get(contextKey);
    const stale = entry !== undefined && !watchable(environmentId);
    if (entry === undefined) {
      const disposables: { dispose(): void | Promise<void> }[] = [];
      const own = <T extends { dispose(): void | Promise<void> }>(value: T): T => {
        disposables.push(value);
        return value;
      };
      try {
        entry = { view: this.buildWorkdir(own, generation, environmentId, cwd), disposables, references: 0 };
      } catch (error) {
        disposeAll(disposables);
        throw error;
      }
      generation.workdirs.set(contextKey, entry);
    }
    const acquired = entry;
    acquired.references += 1;
    let released = false;
    const workdir: ProgramWorkdir = {
      contextKey,
      dirs: acquired.view.dirs,
      fs: acquired.view.fs,
      instructions: acquired.view.instructions,
      skills: acquired.view.skills,
      agentProfiles: acquired.view.agentProfiles,
      dispose: () => {
        if (released) return;
        released = true;
        acquired.references -= 1;
        if (acquired.references > 0 || generation.workdirs.get(contextKey) !== acquired) return;
        generation.workdirs.delete(contextKey);
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

  private buildWorkdir(
    own: <T extends { dispose(): void | Promise<void> }>(value: T) => T,
    harness: ProgramHarness,
    environmentId: string,
    cwd: string,
  ): ProgramView {
    const lease = this.environments.acquire({ environmentId }, PROGRAM_CAPABILITIES);
    try {
      const hostFs = lease.environment.fs!;
      const local = this.environments.inspect(this.binding);
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
        userAgentProfiles: harness.userAgentProfiles,
        explicitSkills: harness.explicitSkills,
        extraSkills: harness.extraSkills,
        pluginSkills: harness.pluginSkills,
      });
    } finally {
      lease.dispose();
    }
  }

  private buildView(
    own: <T extends { dispose(): void | Promise<void> }>(value: T) => T,
    input: ProgramViewInput,
  ): ProgramView {
    const state = own(new WorkspaceStateService(this.dependencies.appState));
    const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, input.hostFs, input.homeDir);
    const dirs = own(new WorkspaceDirsService(input.context, localConfig, this.dependencies.workspaces, this.dependencies.workspaceStore, this.dependencies.log, state));
    const git = new WorkspaceGitService(input.context, input.git);
    const fs = new WorkspaceFsService(input.context, dirs, input.hostFs, this.environments, this.dependencies.telemetry, git, input.environmentId);
    const instructions = own(new WorkspaceInstructionsService(input.context, input.hostFs, input.instructionsHost, this.dependencies.bootstrap, this.dependencies.log, state, input.personalFs, input.watch));
    const agentProfiles: IWorkspaceAgentProfileLoader = input.projectAgentProfiles
      ? own(new WorkspaceAgentProfileLoaderService(input.context, input.hostFs, this.dependencies.log, input.userAgentProfiles, this.dependencies.agentProfiles, input.contextKey, input.watch))
      : { _serviceBrand: undefined, ready: Promise.resolve(), reload: () => Promise.resolve() };
    const workspaceSkills = own(new WorkspaceRootSkillSource(new EnvironmentSkillDiscovery(this.dependencies.log, input.hostFs), input.context, this.dependencies.config, this.dependencies.bootstrap, input.hostFs, input.watch));
    const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, this.dependencies.userSkills, input.explicitSkills, input.extraSkills, workspaceSkills, input.pluginSkills, state));
    return { state, localConfig, dirs, git, fs, instructions, skills, agentProfiles };
  }

  private observeReadiness(generation: ProgramGeneration): void {
    void Promise.all([
      readiness(generation.root.dirs),
      readiness(generation.root.instructions),
      readiness(generation.mcpConfig),
      readiness(generation.mcp),
      readiness(generation.root.skills),
      readiness(generation.root.agentProfiles),
    ]).then(
      () => {
        if (this.generation !== generation) return;
        generation.ready = true;
        this.resolveProgramReady();
        this.refresh();
      },
      () => {
        if (this.generation !== generation) return;
        generation.failed = true;
        this.resolveProgramReady();
        this.refresh();
      },
    );
  }

  private retireGeneration(generation: ProgramGeneration): void {
    if (generation.retired) return;
    generation.retired = true;
    this.releaseGeneration(generation);
  }

  private releaseGeneration(generation: ProgramGeneration): void {
    generation.references -= 1;
    if (generation.references !== 0 || !generation.retired) return;
    this.cleanupGeneration(generation);
  }

  private cleanupGeneration(generation: Pick<ProgramGeneration, 'disposables'>): void {
    const cleanup = (async () => {
      const errors: unknown[] = [];
      for (const disposable of [...generation.disposables].toReversed()) {
        try {
          await disposable.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `program ${this.workspaceId} generation disposal failed`);
    })();
    this.generationCleanups.add(cleanup);
    void cleanup.then(
      () => {
        this.generationCleanups.delete(cleanup);
      },
      (error) => {
        this.generationCleanups.delete(cleanup);
        this.dependencies.log.error('program generation disposal failed', { workspaceId: this.workspaceId, error });
      },
    );
  }

  private resolveProgramReady(): void {
    this.resolveReady?.();
    this.resolveReady = undefined;
  }

  private refresh(): void {
    const local = this.environments.current(LOCAL_ENVIRONMENT_ID);
    if (local === undefined || local.status === 'connecting') this.currentStatus = 'preparing';
    else if (this.generationFailed || this.generation?.failed === true) this.currentStatus = 'degraded';
    else if (this.generation?.ready !== true) this.currentStatus = this.generation === undefined && local.status !== 'ready' ? 'degraded' : 'preparing';
    else this.currentStatus = local.status === 'ready' ? 'ready' : 'degraded';
    this.changeEmitter.fire(this.snapshot());
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

function disposeAll(disposables: readonly { dispose(): void | Promise<void> }[]): void {
  for (const disposable of disposables.toReversed()) void disposable.dispose();
}

function readiness(value: unknown): Promise<void> {
  const ready = (value as { readonly ready?: unknown }).ready;
  return ready !== null && typeof ready === 'object' && 'then' in ready
    ? Promise.resolve(ready as PromiseLike<unknown>).then(() => {})
    : Promise.resolve();
}
