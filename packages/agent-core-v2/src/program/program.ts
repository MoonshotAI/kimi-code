import { Emitter, type Event } from '#/_base/event';
import { UserFileSkillSource } from '#/app/skillCatalog/userFileSkillSource';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import type { RuntimeBinding, RuntimeLease } from '#/runtime/runtime';
import { RuntimeError, type RuntimeGenerationSnapshot, type RuntimeRegistry, type RuntimeRegistryChange } from '#/runtime/runtimeRegistry';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import type { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import { WorkspaceFsService } from '#/workspace/workspaceFs/fsService';
import type { IWorkspaceFsWatchService } from '#/workspace/workspaceFs/fsWatch';
import { WorkspaceFsWatchService } from '#/workspace/workspaceFs/fsWatchService';
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
import { ExplicitFileSkillSource } from '#/workspace/workspaceSkillCatalog/explicitFileSkillSource';
import { ExtraFileSkillSource } from '#/workspace/workspaceSkillCatalog/extraFileSkillSource';
import { PluginSkillSource } from '#/workspace/workspaceSkillCatalog/pluginSkillSource';
import { WorkspaceRootSkillSource } from '#/workspace/workspaceSkillCatalog/rootFileSkillSource';
import { RuntimeSkillDiscovery } from '#/workspace/workspaceSkillCatalog/runtimeSkillDiscovery';
import type { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import { WorkspaceSkillCatalogService } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalogService';
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
  readonly watch: IWorkspaceFsWatchService;
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

const PROGRAM_CAPABILITIES = ['fs', 'process', 'watch'] as const;

export class Program {
  readonly binding: RuntimeBinding;
  private currentStatus: ProgramStatus = 'preparing';
  private readonly changeEmitter = new Emitter<ProgramSnapshot>();
  readonly onDidChange: Event<ProgramSnapshot> = this.changeEmitter.event;
  private readonly registrySubscription;
  private readonly resolver: IRuntimeResolver;
  private generation?: ProgramGeneration;
  private generationFailed = false;
  private disposed = false;
  private resolveReady?: () => void;
  readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  constructor(
    readonly workspaceId: string,
    private readonly runtimes: RuntimeRegistry,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
  ) {
    this.binding = Object.freeze({ workspaceId, runtimeId: 'local' });
    this.resolver = {
      _serviceBrand: undefined,
      inspect: (binding) => this.runtimes.inspect(binding),
      acquire: (binding, required) => this.runtimes.acquire(binding, required),
    };
    this.registrySubscription = runtimes.onDidChange((change) => this.onRuntimeChange(change));
    this.reconcileGeneration();
  }

  get status(): ProgramStatus { return this.currentStatus; }
  get state(): IWorkspaceStateService { return this.requireGeneration().state; }
  get dirs(): IWorkspaceDirs { return this.requireGeneration().dirs; }
  get fs(): IWorkspaceFsService { return this.requireGeneration().fs; }
  get watch(): IWorkspaceFsWatchService { return this.requireGeneration().watch; }
  get git(): IWorkspaceGitService { return this.requireGeneration().git; }
  get instructions(): IWorkspaceInstructionsService { return this.requireGeneration().instructions; }
  get mcpConfig(): IWorkspaceMcpConfigService { return this.requireGeneration().mcpConfig; }
  get mcp(): IWorkspaceMcpService { return this.requireGeneration().mcp; }
  get trust(): IWorkspaceTrust { return this.requireGeneration().trust; }
  get skills(): IWorkspaceSkillCatalog { return this.requireGeneration().skills; }
  get agentProfiles(): IWorkspaceAgentProfileLoader { return this.requireGeneration().agentProfiles; }
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
    const generation = this.generation;
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
    const generation = this.generation;
    this.generation = undefined;
    if (generation !== undefined) this.retireGeneration(generation);
    this.changeEmitter.dispose();
  }

  private requireGeneration(): ProgramGeneration {
    if (this.generation === undefined) throw new Error(`program ${this.workspaceId} has no available local runtime generation`);
    return this.generation;
  }

  private onRuntimeChange(change: RuntimeRegistryChange): void {
    if (change.runtimeId !== 'local' || this.disposed) return;
    this.reconcileGeneration();
  }

  private reconcileGeneration(): void {
    const local = this.runtimes.current('local');
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
        if (!(error instanceof RuntimeError && error.code === 'runtime.unavailable')) {
          this.generationFailed = true;
          this.resolveProgramReady();
        }
      }
    }
    this.refresh();
  }

  private createGeneration(): ProgramGeneration {
    const lease = this.resolver.acquire(this.binding, PROGRAM_CAPABILITIES);
    const runtime = lease.runtime;
    const disposables: { dispose(): void | Promise<void> }[] = [];
    const own = <T extends { dispose(): void | Promise<void> }>(value: T): T => {
      disposables.push(value);
      return value;
    };
    try {
      const state = own(new WorkspaceStateService(this.dependencies.appState));
      const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, runtime.fs!);
      const dirs = own(new WorkspaceDirsService(this.context, localConfig, runtime.watch!, this.dependencies.log, state));
      const git = new WorkspaceGitService(this.context, this.dependencies.git);
      const fs = new WorkspaceFsService(this.context, dirs, runtime.fs!, this.resolver, this.dependencies.telemetry, git);
      const watch = own(new WorkspaceFsWatchService(this.context, dirs, runtime.watch!, runtime.fs!));
      const instructions = own(new WorkspaceInstructionsService(this.context, runtime.fs!, runtime.environment, this.dependencies.bootstrap, runtime.watch!, this.dependencies.log, state));
      const trust = own(new WorkspaceTrustService(this.context, this.dependencies.docs, state));
      const mcpConfig = own(new WorkspaceMcpConfigService(this.context, this.dependencies.bootstrap, this.dependencies.plugins, this.dependencies.log, this.dependencies.config, runtime.watch!, runtime.fs!, trust, this.dependencies.configStore));
      const mcp = own(new WorkspaceMcpService(this.context, this.resolver, mcpConfig, this.dependencies.oauth, this.dependencies.log, this.dependencies.telemetry, this.dependencies.identity, this.dependencies.sessionManager));
      const userAgentProfiles = own(new UserAgentProfileLoaderService(this.dependencies.bootstrap, runtime.fs!, this.dependencies.log, this.dependencies.builtinAgentProfiles, this.context, this.dependencies.agentProfiles));
      const pluginAgentProfiles = own(new PluginAgentProfileLoaderService(this.dependencies.plugins, runtime.fs!, this.dependencies.log, userAgentProfiles, this.context, this.dependencies.agentProfiles));
      const explicitAgentProfiles = own(new ExplicitAgentProfileLoaderService(this.context, this.dependencies.bootstrap, runtime.fs!, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const extraAgentProfiles = own(new ExtraAgentProfileLoaderService(this.dependencies.config, this.context, this.dependencies.bootstrap, runtime.fs!, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const agentProfiles = own(new WorkspaceAgentProfileLoaderService(this.context, runtime.fs!, this.dependencies.log, userAgentProfiles, runtime.watch!, this.dependencies.agentProfiles));
      const skillDiscovery = new RuntimeSkillDiscovery(this.dependencies.log, runtime.fs!);
      const userSkills = own(new UserFileSkillSource(skillDiscovery, this.dependencies.bootstrap, this.dependencies.config));
      const explicitSkills = new ExplicitFileSkillSource(skillDiscovery, this.context, this.dependencies.bootstrap);
      const extraSkills = own(new ExtraFileSkillSource(skillDiscovery, this.dependencies.config, this.context, this.dependencies.bootstrap));
      const workspaceSkills = own(new WorkspaceRootSkillSource(skillDiscovery, this.context, this.dependencies.config, this.dependencies.bootstrap, runtime.watch!));
      const pluginSkills = new PluginSkillSource(skillDiscovery, this.dependencies.plugins);
      const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, userSkills, explicitSkills, extraSkills, workspaceSkills, pluginSkills, state));
      return {
        id: runtime.identity.generation,
        lease,
        state,
        dirs,
        fs,
        watch,
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
      for (const disposable of disposables.reverse()) void disposable.dispose();
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
    for (const disposable of [...generation.disposables].reverse()) void disposable.dispose();
    generation.lease.dispose();
  }

  private resolveProgramReady(): void {
    this.resolveReady?.();
    this.resolveReady = undefined;
  }

  private refresh(): void {
    const local = this.runtimes.current('local');
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
