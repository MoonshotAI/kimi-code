import type { LiveRef } from '#/_base/di/instantiation';
import { Emitter, Event } from '#/_base/event';
import type { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import type { EnvironmentBinding } from '#/environment/environment';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
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

interface ProgramGeneration {
  readonly id: string;
  readonly state: IWorkspaceStateService;
  readonly dirs: IWorkspaceDirs;
  readonly fs: IWorkspaceFsService;
  readonly git: IWorkspaceGitService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly mcpConfig: IWorkspaceMcpConfigService;
  readonly mcp: IWorkspaceMcpService;
  readonly trust: IWorkspaceTrust;
  readonly trustDisclosure: IWorkspaceTrustDisclosure;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly pluginAgentProfiles: IPluginAgentProfileLoader;
  readonly explicitAgentProfiles: IExplicitAgentProfileLoader;
  readonly extraAgentProfiles: IExtraAgentProfileLoader;
  readonly explicitSkills: ExplicitFileSkillSource;
  readonly extraSkills: ExtraFileSkillSource;
  readonly pluginSkills: PluginSkillSource;
  readonly disposables: readonly { dispose(): void | Promise<void> }[];
  ready: boolean;
  failed: boolean;
  references: number;
  retired: boolean;
}

export interface ProgramWorkdir {
  readonly dirs: IWorkspaceDirs;
  readonly fs: IWorkspaceFsService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  dispose(): void;
}

interface ProgramViewInput {
  readonly context: IWorkspaceContext;
  readonly hostFs: IHostFileSystem;
  readonly environmentId: string;
  readonly homeDir?: string;
  readonly git: LiveRef<IGitService>;
  readonly instructionsHost: HostEnvironmentInfo;
  readonly personalFs?: IHostFileSystem;
  readonly watch: boolean;
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly contextKey?: string;
  readonly explicitSkills: IExplicitFileSkillSource;
  readonly extraSkills: IExtraFileSkillSource;
  readonly pluginSkills: IPluginSkillSource;
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
  get state(): IWorkspaceStateService { return this.requireGeneration().state; }
  get dirs(): IWorkspaceDirs { return this.requireGeneration().dirs; }
  get fs(): IWorkspaceFsService { return this.requireGeneration().fs; }
  get git(): IWorkspaceGitService { return this.requireGeneration().git; }
  get instructions(): IWorkspaceInstructionsService { return this.requireGeneration().instructions; }
  get mcpConfig(): IWorkspaceMcpConfigService { return this.requireGeneration().mcpConfig; }
  get mcp(): IWorkspaceMcpService { return this.requireGeneration().mcp; }
  get trust(): IWorkspaceTrust { return this.requireGeneration().trust; }
  get trustDisclosure(): IWorkspaceTrustDisclosure { return this.requireGeneration().trustDisclosure; }
  get skills(): IWorkspaceSkillCatalog { return this.requireGeneration().skills; }
  get agentProfiles(): IWorkspaceAgentProfileLoader { return this.requireGeneration().agentProfiles; }
  get userAgentProfiles(): IUserAgentProfileLoader { return this.requireGeneration().userAgentProfiles; }
  get sessionControllerGeneration(): string { return this.requireGeneration().id; }

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
        workspaceAgentProfiles: generation.agentProfiles,
        extraAgentProfiles: generation.extraAgentProfiles,
        explicitAgentProfiles: generation.explicitAgentProfiles,
        userAgentProfiles: generation.userAgentProfiles,
        pluginAgentProfiles: generation.pluginAgentProfiles,
        dirs: generation.dirs,
        skills: generation.skills,
        instructions: generation.instructions,
        mcp: generation.mcp,
        fs: generation.fs,
        createWorkdir: (environmentId, cwd, contextKey) => this.createWorkdir(generation, environmentId, cwd, contextKey),
        onDispose: release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  snapshot(): ProgramSnapshot {
    const generation = this.generation;
    const skills = generation?.skills.catalog.listSkills() ?? [];
    const skillsBySource = new Map<string, number>();
    for (const skill of skills) {
      skillsBySource.set(skill.source, (skillsBySource.get(skill.source) ?? 0) + 1);
    }
    const agentProfiles = this.dependencies.agentProfiles.entries()
      .filter((entry) =>
        (entry.workspaceKey === undefined || entry.workspaceKey === this.workspaceId) &&
        entry.contextKey === undefined,
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
          invocable: generation?.skills.catalog.listInvocableSkills().length ?? 0,
          skipped: generation?.skills.catalog.getSkippedByPolicy().length ?? 0,
        },
        agentProfiles: agentProfiles.reduce((total, source) => total + source.profiles.length, 0),
        mcpServers: mcpServers.length,
      },
      sources: {
        skills: [...skillsBySource].map(([source, count]) => ({ source, count })),
        skillRoots: generation?.skills.catalog.getSkillRoots() ?? [],
        agentProfiles,
        instructionPaths: generation?.instructions.snapshot.agentsMdPaths ?? [],
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
      const view = this.buildView(own, {
        context: this.context,
        hostFs,
        environmentId: LOCAL_ENVIRONMENT_ID,
        git: this.dependencies.git,
        instructionsHost: environment.host!,
        watch: true,
        userAgentProfiles,
        explicitSkills,
        extraSkills,
        pluginSkills,
      });
      const trust = own(new WorkspaceTrustService(this.context, this.dependencies.trustStore, view.state));
      const mcpConfig = own(new WorkspaceMcpConfigService(this.context, this.dependencies.bootstrap, this.dependencies.plugins, this.dependencies.log, this.dependencies.config, hostFs, trust, this.dependencies.configStore));
      const mcp = own(new WorkspaceMcpService(this.context, this.environments, mcpConfig, this.dependencies.oauth, this.dependencies.log, this.dependencies.telemetry, this.dependencies.identity, this.dependencies.sessionManager));
      const trustDisclosure = new WorkspaceTrustDisclosureService(this.context, hostFs, this.dependencies.bootstrap, this.dependencies.config, view.localConfig, trust, view.skills, view.agentProfiles, this.dependencies.agentProfiles, view.instructions, this.dependencies.log);
      return {
        id: environment.identity.generation,
        state: view.state,
        dirs: view.dirs,
        fs: view.fs,
        git: view.git,
        instructions: view.instructions,
        mcpConfig,
        mcp,
        trust,
        trustDisclosure,
        skills: view.skills,
        agentProfiles: view.agentProfiles,
        userAgentProfiles,
        pluginAgentProfiles,
        explicitAgentProfiles,
        extraAgentProfiles,
        explicitSkills,
        extraSkills,
        pluginSkills,
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

  private createWorkdir(generation: ProgramGeneration, environmentId: string, cwd: string, contextKey: string): ProgramWorkdir {
    const lease = this.environments.acquire({ environmentId }, PROGRAM_CAPABILITIES);
    const disposables: { dispose(): void | Promise<void> }[] = [];
    const own = <T extends { dispose(): void | Promise<void> }>(value: T): T => {
      disposables.push(value);
      return value;
    };
    const dispose = (): void => {
      for (const disposable of disposables.toReversed()) void disposable.dispose();
    };
    try {
      const hostFs = lease.environment.fs!;
      const local = this.environments.inspect(this.binding);
      const view = this.buildView(own, {
        context: { ...this.context, cwd },
        hostFs,
        environmentId,
        homeDir: lease.environment.host?.homeDir ?? '',
        git: {
          current: new GitService(this.environments, hostFs, environmentId),
          onDidChange: Event.None as Event<void>,
        },
        instructionsHost: local.host!,
        personalFs: local.fs,
        watch: false,
        userAgentProfiles: generation.userAgentProfiles,
        contextKey,
        explicitSkills: generation.explicitSkills,
        extraSkills: generation.extraSkills,
        pluginSkills: generation.pluginSkills,
      });
      return {
        dirs: view.dirs,
        fs: view.fs,
        instructions: view.instructions,
        skills: view.skills,
        agentProfiles: view.agentProfiles,
        dispose,
      };
    } catch (error) {
      dispose();
      throw error;
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
    const dirs = own(new WorkspaceDirsService(input.context, localConfig, this.dependencies.log, state));
    const git = new WorkspaceGitService(input.context, input.git);
    const fs = new WorkspaceFsService(input.context, dirs, input.hostFs, this.environments, this.dependencies.telemetry, git, input.environmentId);
    const instructions = own(new WorkspaceInstructionsService(input.context, input.hostFs, input.instructionsHost, this.dependencies.bootstrap, this.dependencies.log, state, input.personalFs, input.watch));
    const agentProfiles = own(new WorkspaceAgentProfileLoaderService(input.context, input.hostFs, this.dependencies.log, input.userAgentProfiles, this.dependencies.agentProfiles, input.contextKey, input.watch));
    const workspaceSkills = own(new WorkspaceRootSkillSource(new EnvironmentSkillDiscovery(this.dependencies.log, input.hostFs), input.context, this.dependencies.config, this.dependencies.bootstrap, input.hostFs, input.watch));
    const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, this.dependencies.userSkills, input.explicitSkills, input.extraSkills, workspaceSkills, input.pluginSkills, state));
    return { state, localConfig, dirs, git, fs, instructions, skills, agentProfiles };
  }

  private observeReadiness(generation: ProgramGeneration): void {
    void Promise.all([
      readiness(generation.dirs),
      readiness(generation.instructions),
      readiness(generation.mcpConfig),
      readiness(generation.mcp),
      readiness(generation.skills),
      readiness(generation.agentProfiles),
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

function readiness(value: unknown): Promise<void> {
  const ready = (value as { readonly ready?: unknown }).ready;
  return ready !== null && typeof ready === 'object' && 'then' in ready
    ? Promise.resolve(ready as PromiseLike<unknown>).then(() => {})
    : Promise.resolve();
}
