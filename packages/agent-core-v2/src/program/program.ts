import { Emitter, type Event } from '#/_base/event';
import { UserFileSkillSource } from '#/features/skill/catalog/userFileSkillSource';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import type { RuntimeBinding, RuntimeLease, RuntimeWorkspaceRoots } from '#/runtime/runtime';
import { LOCAL_RUNTIME_ID } from '#/runtime/runtime';
import { RuntimeError, type RuntimeGenerationSnapshot, type RuntimeRegistry, type RuntimeRegistryChange } from '#/runtime/runtimeRegistry';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import type { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import type { FsSuggestRequest, FsSuggestResponse, IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
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
import { ExplicitFileSkillSource } from '#/features/skill/workspace/explicitFileSkillSource';
import { ExtraFileSkillSource } from '#/features/skill/workspace/extraFileSkillSource';
import { PluginSkillSource } from '#/features/skill/workspace/pluginSkillSource';
import { WorkspaceRootSkillSource } from '#/features/skill/workspace/rootFileSkillSource';
import { RuntimeSkillDiscovery } from '#/features/skill/workspace/runtimeSkillDiscovery';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import { WorkspaceSkillCatalogService } from '#/features/skill/workspace/workspaceSkillCatalogService';
import type { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

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
  readonly binding: RuntimeBinding;
  readonly status: ProgramStatus;
  readonly ready: boolean;
  readonly generation?: string;
  readonly trusted?: boolean;
  readonly catalog: ProgramCatalogSnapshot;
  readonly sources: ProgramSourceProvenanceSnapshot;
  readonly runtimes: readonly RuntimeGenerationSnapshot[];
}

interface ProgramGeneration {
  readonly id: string;
  readonly lease: RuntimeLease;
  readonly state: IWorkspaceStateService;
  readonly dirs: IWorkspaceDirs;
  readonly fs: IWorkspaceFsService;
  readonly git: IWorkspaceGitService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly mcpConfig: IWorkspaceMcpConfigService;
  readonly mcp: IWorkspaceMcpService;
  readonly trust: IWorkspaceTrust;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly pluginAgentProfiles: IPluginAgentProfileLoader;
  readonly explicitAgentProfiles: IExplicitAgentProfileLoader;
  readonly extraAgentProfiles: IExtraAgentProfileLoader;
  readonly disposables: readonly { dispose(): void | Promise<void> }[];
  ready: boolean;
  failed: boolean;
  references: number;
  retired: boolean;
}

const PROGRAM_CAPABILITIES = ['fs', 'process'] as const;

export class Program {
  readonly binding: RuntimeBinding;
  private currentStatus: ProgramStatus = 'preparing';
  private readonly changeEmitter = new Emitter<ProgramSnapshot>();
  readonly onDidChange: Event<ProgramSnapshot> = this.changeEmitter.event;
  private readonly registrySubscription;
  private readonly resolver: IRuntimeResolver;
  private readonly generations = new Map<string, ProgramGeneration>();
  private readonly failedGenerations = new Set<string>();
  private readonly reconciledGenerations = new Set<string>();
  private disposed = false;
  private resolveReady?: () => void;
  readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  constructor(
    readonly workspaceId: string,
    private readonly runtimes: RuntimeRegistry,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
  ) {
    this.binding = Object.freeze({ workspaceId, runtimeId: LOCAL_RUNTIME_ID });
    this.resolver = {
      _serviceBrand: undefined,
      inspect: (binding) => this.runtimes.inspect(binding),
      acquire: (binding, required) => this.runtimes.acquire(binding, required),
    };
    this.registrySubscription = runtimes.onDidChange((change) => this.onRuntimeChange(change));
    this.reconcileGeneration(LOCAL_RUNTIME_ID);
  }

  get status(): ProgramStatus { return this.currentStatus; }
  get state(): IWorkspaceStateService { return this.requireGeneration(LOCAL_RUNTIME_ID).state; }
  get dirs(): IWorkspaceDirs { return this.requireGeneration(LOCAL_RUNTIME_ID).dirs; }
  get fs(): IWorkspaceFsService { return this.requireGeneration(LOCAL_RUNTIME_ID).fs; }
  get git(): IWorkspaceGitService { return this.requireGeneration(LOCAL_RUNTIME_ID).git; }
  get instructions(): IWorkspaceInstructionsService { return this.requireGeneration(LOCAL_RUNTIME_ID).instructions; }
  get mcpConfig(): IWorkspaceMcpConfigService { return this.requireGeneration(LOCAL_RUNTIME_ID).mcpConfig; }
  get mcp(): IWorkspaceMcpService { return this.requireGeneration(LOCAL_RUNTIME_ID).mcp; }
  get trust(): IWorkspaceTrust { return this.requireGeneration(LOCAL_RUNTIME_ID).trust; }
  get skills(): IWorkspaceSkillCatalog { return this.requireGeneration(LOCAL_RUNTIME_ID).skills; }
  get agentProfiles(): IWorkspaceAgentProfileLoader { return this.requireGeneration(LOCAL_RUNTIME_ID).agentProfiles; }
  get sessionControllerGeneration(): string { return this.sessionControllerGenerationFor(LOCAL_RUNTIME_ID); }

  sessionControllerGenerationFor(runtimeId: string): string {
    return this.requireGeneration(runtimeId).id;
  }

  async suggestFiles(
    runtimeId: string,
    roots: RuntimeWorkspaceRoots,
    request: FsSuggestRequest,
  ): Promise<FsSuggestResponse> {
    const lease = this.resolver.acquire({ workspaceId: this.workspaceId, runtimeId }, ['fs']);
    try {
      const mapped = lease.runtime.workspace.mapRoots(roots);
      const context: IWorkspaceContext = { ...this.context, cwd: mapped.workDir };
      const dirs = {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        additionalDirs: mapped.additionalDirs ?? [],
        onDidChange: () => ({ dispose: () => {} }),
        addDir: async () => {
          throw new Error('session fs directories are immutable');
        },
        mergeAdditionalDirs: async () => {
          throw new Error('session fs directories are immutable');
        },
        sessionInfo: () => ({ workDir: mapped.workDir, additionalDirs: mapped.additionalDirs ?? [] }),
      } as unknown as IWorkspaceDirs;
      const fs = new WorkspaceFsService(
        context,
        dirs,
        lease.runtime.fs!,
        this.resolver,
        this.dependencies.telemetry,
        new WorkspaceGitService(context, this.dependencies.git),
        runtimeId,
      );
      return await fs.suggest(request);
    } finally {
      lease.dispose();
    }
  }

  createSessionController(runtimeId: string = LOCAL_RUNTIME_ID): SessionLifecycleService {
    const generation = this.requireGeneration(runtimeId);
    generation.references += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.releaseGeneration(generation);
    };
    try {
      const runtime = generation.lease.runtime;
      return this.dependencies.createSessionController({
        context: this.context,
        fs: runtime.fs!,
        workspaceAgentProfiles: generation.agentProfiles,
        extraAgentProfiles: generation.extraAgentProfiles,
        explicitAgentProfiles: generation.explicitAgentProfiles,
        userAgentProfiles: generation.userAgentProfiles,
        pluginAgentProfiles: generation.pluginAgentProfiles,
        dirs: generation.dirs,
        skills: generation.skills,
        instructions: generation.instructions,
        mcp: generation.mcp,
        onDispose: release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  snapshot(): ProgramSnapshot {
    const generation = this.generations.get(LOCAL_RUNTIME_ID);
    const skills = generation?.skills.catalog.listSkills() ?? [];
    const skillsBySource = new Map<string, number>();
    for (const skill of skills) {
      skillsBySource.set(skill.source, (skillsBySource.get(skill.source) ?? 0) + 1);
    }
    const agentProfiles = this.dependencies.agentProfiles.entries()
      .filter((entry) => entry.workspaceKey === undefined || entry.workspaceKey === this.workspaceId)
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
      runtimes: this.runtimes.snapshot().runtimes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registrySubscription.dispose();
    const generations = [...this.generations.values()];
    this.generations.clear();
    for (const generation of generations) this.retireGeneration(generation);
    this.changeEmitter.dispose();
  }

  private requireGeneration(runtimeId: string): ProgramGeneration {
    let generation = this.generations.get(runtimeId);
    if (generation === undefined && !this.reconciledGenerations.has(runtimeId)) {
      this.reconcileGeneration(runtimeId);
      generation = this.generations.get(runtimeId);
    }
    if (generation === undefined) {
      throw new Error(`program ${this.workspaceId} has no available generation for runtime ${runtimeId}`);
    }
    return generation;
  }

  private onRuntimeChange(change: RuntimeRegistryChange): void {
    if (this.disposed) return;
    if (change.runtimeId !== LOCAL_RUNTIME_ID && !this.reconciledGenerations.has(change.runtimeId)) return;
    this.reconcileGeneration(change.runtimeId);
  }

  private reconcileGeneration(runtimeId: string): void {
    this.reconciledGenerations.add(runtimeId);
    const current = this.runtimes.current(runtimeId);
    if (current === undefined) {
      const previous = this.generations.get(runtimeId);
      this.generations.delete(runtimeId);
      if (previous !== undefined) this.retireGeneration(previous);
      this.refresh();
      return;
    }
    if (this.generations.get(runtimeId)?.id !== current.identity.generation) {
      const previous = this.generations.get(runtimeId);
      this.failedGenerations.delete(runtimeId);
      try {
        const next = this.createGeneration(runtimeId);
        this.generations.set(runtimeId, next);
        if (previous !== undefined) this.retireGeneration(previous);
        this.observeReadiness(next);
      } catch (error) {
        if (!(error instanceof RuntimeError && error.code === 'runtime.unavailable')) {
          this.failedGenerations.add(runtimeId);
          this.resolveProgramReady();
        }
      }
    }
    this.refresh();
  }

  private createGeneration(runtimeId: string): ProgramGeneration {
    const lease = this.resolver.acquire({ workspaceId: this.workspaceId, runtimeId }, PROGRAM_CAPABILITIES);
    const runtime = lease.runtime;
    const disposables: { dispose(): void | Promise<void> }[] = [];
    const own = <T extends { dispose(): void | Promise<void> }>(value: T): T => {
      disposables.push(value);
      return value;
    };
    try {
      const state = own(new WorkspaceStateService(this.dependencies.appState));
      const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, runtime.fs!);
      const dirs = own(new WorkspaceDirsService(this.context, localConfig, this.dependencies.log, state));
      const git = new WorkspaceGitService(this.context, this.dependencies.git);
      const fs = new WorkspaceFsService(this.context, dirs, runtime.fs!, this.resolver, this.dependencies.telemetry, git);
      const instructions = own(new WorkspaceInstructionsService(this.context, runtime.fs!, runtime.environment, this.dependencies.bootstrap, this.dependencies.log, state));
      const trust = own(new WorkspaceTrustService(this.context, this.dependencies.docs, state, this.dependencies.telemetry));
      const mcpConfig = own(new WorkspaceMcpConfigService(this.context, this.dependencies.bootstrap, this.dependencies.plugins, this.dependencies.log, this.dependencies.config, runtime.fs!, trust, this.dependencies.configStore));
      const mcp = own(new WorkspaceMcpService(this.context, this.resolver, mcpConfig, this.dependencies.oauth, this.dependencies.log, this.dependencies.telemetry, this.dependencies.identity, this.dependencies.sessionManager));
      const userAgentProfiles = own(new UserAgentProfileLoaderService(this.dependencies.bootstrap, runtime.fs!, this.dependencies.log, this.dependencies.builtinAgentProfiles, this.context, this.dependencies.agentProfiles));
      const pluginAgentProfiles = own(new PluginAgentProfileLoaderService(this.dependencies.plugins, runtime.fs!, this.dependencies.log, userAgentProfiles, this.context, this.dependencies.agentProfiles));
      const explicitAgentProfiles = own(new ExplicitAgentProfileLoaderService(this.context, this.dependencies.bootstrap, runtime.fs!, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const extraAgentProfiles = own(new ExtraAgentProfileLoaderService(this.dependencies.config, this.context, this.dependencies.bootstrap, runtime.fs!, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const agentProfiles = own(new WorkspaceAgentProfileLoaderService(this.context, runtime.fs!, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const skillDiscovery = new RuntimeSkillDiscovery(this.dependencies.log, runtime.fs!);
      const userSkills = own(new UserFileSkillSource(skillDiscovery, this.dependencies.bootstrap, this.dependencies.config));
      const explicitSkills = new ExplicitFileSkillSource(skillDiscovery, this.context, this.dependencies.bootstrap, runtime.fs!);
      const extraSkills = own(new ExtraFileSkillSource(skillDiscovery, this.dependencies.config, this.context, this.dependencies.bootstrap, runtime.fs!));
      const workspaceSkills = own(new WorkspaceRootSkillSource(skillDiscovery, this.context, this.dependencies.config, this.dependencies.bootstrap, runtime.fs!));
      const pluginSkills = new PluginSkillSource(skillDiscovery, this.dependencies.plugins);
      const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, userSkills, explicitSkills, extraSkills, workspaceSkills, pluginSkills, state));
      return {
        id: runtime.identity.generation,
        lease,
        state,
        dirs,
        fs,
        git,
        instructions,
        mcpConfig,
        mcp,
        trust,
        skills,
        agentProfiles,
        userAgentProfiles,
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
      for (const disposable of disposables.toReversed()) void disposable.dispose();
      lease.dispose();
      throw error;
    }
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
        if (this.generations.get(generation.lease.runtime.identity.runtimeId) !== generation) return;
        generation.ready = true;
        this.resolveProgramReady();
        this.refresh();
      },
      () => {
        if (this.generations.get(generation.lease.runtime.identity.runtimeId) !== generation) return;
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
    for (const disposable of [...generation.disposables].toReversed()) void disposable.dispose();
    generation.lease.dispose();
  }

  private resolveProgramReady(): void {
    this.resolveReady?.();
    this.resolveReady = undefined;
  }

  private refresh(): void {
    const local = this.runtimes.current(LOCAL_RUNTIME_ID);
    const generation = this.generations.get(LOCAL_RUNTIME_ID);
    if (local === undefined || local.status === 'connecting') this.currentStatus = 'preparing';
    else if (this.failedGenerations.has(LOCAL_RUNTIME_ID) || generation?.failed === true) this.currentStatus = 'degraded';
    else if (generation?.ready !== true) this.currentStatus = generation === undefined && local.status !== 'ready' ? 'degraded' : 'preparing';
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
