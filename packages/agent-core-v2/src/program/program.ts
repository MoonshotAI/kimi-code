import { AsyncEmitter, Emitter, Event, type IWaitUntil } from '#/_base/event';
import { GitService } from '#/app/git/gitService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import type { Environment, EnvironmentBinding, EnvironmentLease, EnvironmentWorkspaceRoots } from '#/environment/environment';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { EnvironmentError, type EnvironmentGenerationSnapshot, type EnvironmentRegistry, type EnvironmentRegistryChange } from '#/environment/environmentRegistry';
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
import type { IWorkspaceTrust, WorkspaceTrustChange } from '#/workspace/workspaceTrust/workspaceTrust';
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
import { EnvironmentSkillDiscovery } from '#/features/skill/workspace/environmentSkillDiscovery';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import { WorkspaceSkillCatalogService } from '#/features/skill/workspace/workspaceSkillCatalogService';
import type { IEnvironmentResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

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
  lease?: EnvironmentLease;
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
  readonly binding: EnvironmentBinding;
  private currentStatus: ProgramStatus = 'preparing';
  private readonly changeEmitter = new Emitter<ProgramSnapshot>();
  readonly onDidChange: Event<ProgramSnapshot> = this.changeEmitter.event;
  private readonly trustChangeEmitter = new AsyncEmitter<WorkspaceTrustChange & IWaitUntil>();
  readonly onDidChangeTrust: Event<WorkspaceTrustChange & IWaitUntil> = this.trustChangeEmitter.event;
  private readonly registrySubscription;
  private readonly resolver: IEnvironmentResolver;
  private readonly generations = new Map<string, ProgramGeneration>();
  private readonly failedGenerations = new Set<string>();
  private readonly reconciledGenerations = new Map<string, { readonly environmentId: string; readonly cwd?: string }>();
  private disposed = false;
  private resolveReady?: () => void;
  readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  constructor(
    readonly workspaceId: string,
    private readonly environments: EnvironmentRegistry,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
  ) {
    this.binding = Object.freeze({ workspaceId, environmentId: LOCAL_ENVIRONMENT_ID });
    this.resolver = {
      _serviceBrand: undefined,
      inspect: (binding) => this.environments.inspect(binding),
      acquire: (binding, required) => this.environments.acquire(binding, required),
      acquireWhenReady: (binding, required) => this.environments.acquireWhenReady(binding, required),
    };
    this.registrySubscription = environments.onDidChange((change) => this.onEnvironmentChange(change));
    this.reconcileGeneration(LOCAL_ENVIRONMENT_ID);
  }

  get status(): ProgramStatus { return this.currentStatus; }
  get state(): IWorkspaceStateService { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).state; }
  get dirs(): IWorkspaceDirs { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).dirs; }
  get fs(): IWorkspaceFsService { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).fs; }
  get git(): IWorkspaceGitService { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).git; }
  get instructions(): IWorkspaceInstructionsService { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).instructions; }
  get mcpConfig(): IWorkspaceMcpConfigService { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).mcpConfig; }
  get mcp(): IWorkspaceMcpService { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).mcp; }
  get trust(): IWorkspaceTrust { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).trust; }
  get skills(): IWorkspaceSkillCatalog { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).skills; }
  get agentProfiles(): IWorkspaceAgentProfileLoader { return this.requireGeneration(LOCAL_ENVIRONMENT_ID).agentProfiles; }

  sessionControllerGenerationFor(environmentId: string, cwd?: string): string {
    return this.requireGeneration(environmentId, cwd).id;
  }

  async suggestFiles(
    environmentId: string,
    roots: EnvironmentWorkspaceRoots,
    request: FsSuggestRequest,
  ): Promise<FsSuggestResponse> {
    const lease = this.resolver.acquire({ workspaceId: this.workspaceId, environmentId }, ['fs']);
    try {
      const mapped = lease.environment.workspace.mapRoots(roots);
      const context: IWorkspaceContext = { ...this.context, cwd: mapped.workDir };
      const dirs = { additionalDirs: mapped.additionalDirs ?? [] };
      const fs = new WorkspaceFsService(
        context,
        dirs,
        lease.environment.fs!,
        this.resolver,
        this.dependencies.telemetry,
        new WorkspaceGitService(context, this.dependencies.git),
        environmentId,
      );
      return await fs.suggest(request);
    } finally {
      lease.dispose();
    }
  }

  createSessionController(environmentId: string = LOCAL_ENVIRONMENT_ID, cwd?: string): SessionLifecycleService {
    const generation = this.requireGeneration(environmentId, cwd);
    generation.lease ??= this.resolver.acquire({ workspaceId: this.workspaceId, environmentId }, PROGRAM_CAPABILITIES);
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
        environments: this.environments,
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
    const generation = this.generations.get(LOCAL_ENVIRONMENT_ID);
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
      environments: this.environments.snapshot().environments,
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
    this.trustChangeEmitter.dispose();
  }

  private requireGeneration(environmentId: string, cwd?: string): ProgramGeneration {
    const key = generationKey(environmentId, cwd);
    let generation = this.generations.get(key);
    if (generation === undefined && !this.reconciledGenerations.has(key)) {
      this.reconcileGeneration(environmentId, cwd);
      generation = this.generations.get(key);
    }
    if (generation === undefined) {
      throw new Error(`program ${this.workspaceId} has no available generation for environment ${environmentId}`);
    }
    return generation;
  }

  private onEnvironmentChange(change: EnvironmentRegistryChange): void {
    if (this.disposed) return;
    for (const request of this.reconciledGenerations.values()) {
      if (request.environmentId === change.environmentId) {
        this.reconcileGeneration(request.environmentId, request.cwd);
      }
    }
  }

  private reconcileGeneration(environmentId: string, cwd?: string): void {
    const key = generationKey(environmentId, cwd);
    this.reconciledGenerations.set(key, { environmentId, cwd });
    const current = this.environments.current(environmentId);
    if (current === undefined) {
      const previous = this.generations.get(key);
      this.generations.delete(key);
      if (previous !== undefined) this.retireGeneration(previous);
      this.refresh();
      return;
    }
    if (this.generations.get(key)?.id !== current.identity.generation) {
      const previous = this.generations.get(key);
      this.failedGenerations.delete(key);
      try {
        const next = this.createGeneration(environmentId, cwd);
        this.generations.set(key, next);
        if (previous !== undefined) this.retireGeneration(previous);
        this.observeReadiness(key, next);
      } catch (error) {
        if (previous !== undefined) {
          this.generations.delete(key);
          this.retireGeneration(previous);
        }
        if (!(error instanceof EnvironmentError && error.code === 'environment.unavailable')) {
          this.failedGenerations.add(key);
          this.resolveProgramReady();
        }
      }
    }
    this.refresh();
  }

  private createGeneration(environmentId: string, cwd?: string): ProgramGeneration {
    const lease = this.resolver.acquire({ workspaceId: this.workspaceId, environmentId }, PROGRAM_CAPABILITIES);
    const environment = lease.environment;
    const disposables: { dispose(): void | Promise<void> }[] = [];
    const own = <T extends { dispose(): void | Promise<void> }>(value: T): T => {
      disposables.push(value);
      return value;
    };
    try {
      const localEnvironment = this.environments.current(LOCAL_ENVIRONMENT_ID);
      if (localEnvironment?.fs === undefined) {
        throw new Error(`program ${this.workspaceId} has no local environment fs`);
      }
      const localFs = localEnvironment.fs;
      const targetFs = environment.fs!;
      const root = cwd ?? this.context.cwd;
      const context: IWorkspaceContext = root === this.context.cwd ? this.context : { ...this.context, cwd: root };
      const state = own(new WorkspaceStateService(this.dependencies.appState));
      const localConfig = new FileProjectLocalConfigService(this.dependencies.bootstrap, targetFs);
      const dirs = own(new WorkspaceDirsService(context, localConfig, this.dependencies.log, state));
      const git = environmentId === LOCAL_ENVIRONMENT_ID
        ? new WorkspaceGitService(this.context, this.dependencies.git)
        : new WorkspaceGitService(context, {
            current: new GitService(
              {
                _serviceBrand: undefined,
                inspect: () => this.resolver.inspect({ workspaceId: this.workspaceId, environmentId }),
                acquire: (_binding, required) => this.resolver.acquire({ workspaceId: this.workspaceId, environmentId }, required),
                acquireWhenReady: (_binding, required) => this.resolver.acquireWhenReady({ workspaceId: this.workspaceId, environmentId }, required),
              },
              { findByRoot: () => ({ id: this.workspaceId }) },
              targetFs,
            ),
            onDidChange: Event.None as Event<void>,
          });
      const fs = new WorkspaceFsService(context, dirs, targetFs, this.resolver, this.dependencies.telemetry, git, environmentId);
      const instructions = own(new WorkspaceInstructionsService(context, workspaceRoutingFs(root, targetFs, localFs), localEnvironment.host, this.dependencies.bootstrap, this.dependencies.log, state));
      const trust = own(new WorkspaceTrustService(this.context, this.dependencies.docs, state, this.dependencies.telemetry));
      if (environmentId === LOCAL_ENVIRONMENT_ID) {
        own(trust.onDidChange((change) => {
          change.waitUntil(this.trustChangeEmitter.fireAsync({ trusted: change.trusted }, change.signal));
        }));
      }
      const mcpConfig = own(new WorkspaceMcpConfigService(this.context, this.dependencies.bootstrap, this.dependencies.plugins, this.dependencies.log, this.dependencies.config, localFs, trust, this.dependencies.configStore));
      const mcp = own(new WorkspaceMcpService(this.context, this.resolver, mcpConfig, this.dependencies.oauth, this.dependencies.log, this.dependencies.telemetry, this.dependencies.identity, this.dependencies.sessionManager));
      const userAgentProfiles = own(new UserAgentProfileLoaderService(this.dependencies.bootstrap, localFs, this.dependencies.log, this.dependencies.builtinAgentProfiles, this.context, this.dependencies.agentProfiles));
      const pluginAgentProfiles = own(new PluginAgentProfileLoaderService(this.dependencies.plugins, localFs, this.dependencies.log, userAgentProfiles, this.context, this.dependencies.agentProfiles));
      const explicitAgentProfiles = own(new ExplicitAgentProfileLoaderService(this.context, this.dependencies.bootstrap, localFs, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const extraAgentProfiles = own(new ExtraAgentProfileLoaderService(this.dependencies.config, this.context, this.dependencies.bootstrap, localFs, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const agentProfiles = own(new WorkspaceAgentProfileLoaderService(context, targetFs, this.dependencies.log, userAgentProfiles, this.dependencies.agentProfiles));
      const localSkillDiscovery = new EnvironmentSkillDiscovery(this.dependencies.log, localFs);
      const targetSkillDiscovery = new EnvironmentSkillDiscovery(this.dependencies.log, targetFs);
      const userSkills = this.dependencies.userSkills;
      const explicitSkills = new ExplicitFileSkillSource(localSkillDiscovery, this.context, this.dependencies.bootstrap, localFs);
      const extraSkills = own(new ExtraFileSkillSource(localSkillDiscovery, this.dependencies.config, this.context, this.dependencies.bootstrap, localFs));
      const workspaceSkills = own(new WorkspaceRootSkillSource(targetSkillDiscovery, context, this.dependencies.config, this.dependencies.bootstrap, targetFs));
      const pluginSkills = new PluginSkillSource(localSkillDiscovery, this.dependencies.plugins);
      const skills = own(new WorkspaceSkillCatalogService(this.dependencies.builtinSkills, userSkills, explicitSkills, extraSkills, workspaceSkills, pluginSkills, state));
      return {
        id: environment.identity.generation,
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
      throw error;
    } finally {
      lease.dispose();
    }
  }

  private observeReadiness(key: string, generation: ProgramGeneration): void {
    void Promise.all([
      readiness(generation.dirs),
      readiness(generation.instructions),
      readiness(generation.mcpConfig),
      readiness(generation.mcp),
      readiness(generation.skills),
      readiness(generation.agentProfiles),
    ]).then(
      () => {
        if (this.generations.get(key) !== generation) return;
        generation.ready = true;
        this.resolveProgramReady();
        this.refresh();
      },
      () => {
        if (this.generations.get(key) !== generation) return;
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
    if (generation.references === 0 && generation.retired) {
      for (const disposable of [...generation.disposables].toReversed()) void disposable.dispose();
      generation.lease?.dispose();
      generation.lease = undefined;
      return;
    }
    if (generation.references === 1 && !generation.retired) {
      generation.lease?.dispose();
      generation.lease = undefined;
    }
  }

  private resolveProgramReady(): void {
    this.resolveReady?.();
    this.resolveReady = undefined;
  }

  private refresh(): void {
    const local = this.environments.current(LOCAL_ENVIRONMENT_ID);
    const generation = this.generations.get(LOCAL_ENVIRONMENT_ID);
    if (local === undefined || local.status === 'connecting') this.currentStatus = 'preparing';
    else if (this.failedGenerations.has(LOCAL_ENVIRONMENT_ID) || generation?.failed === true) this.currentStatus = 'degraded';
    else if (generation?.ready !== true) this.currentStatus = generation === undefined && local.status !== 'ready' ? 'degraded' : 'preparing';
    else this.currentStatus = local.status === 'ready' ? 'ready' : 'degraded';
    this.changeEmitter.fire(this.snapshot());
  }
}

function generationKey(environmentId: string, cwd?: string): string {
  return cwd === undefined ? environmentId : `${environmentId}\0${cwd}`;
}

function workspaceRoutingFs(root: string, workspaceFs: NonNullable<Environment['fs']>, localFs: NonNullable<Environment['fs']>): NonNullable<Environment['fs']> {
  const base = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
  const onTarget = (path: string): boolean =>
    base === '/' || path === base || path.startsWith(`${base}/`) || base.startsWith(path.endsWith('/') ? path : `${path}/`);
  const route = (path: string): NonNullable<Environment['fs']> => (onTarget(path) ? workspaceFs : localFs);
  return {
    _serviceBrand: undefined,
    readText: (path, options) => route(path).readText(path, options),
    writeText: (path, data) => route(path).writeText(path, data),
    appendText: (path, data) => route(path).appendText(path, data),
    readBytes: (path, n, offset) => route(path).readBytes(path, n, offset),
    writeBytes: (path, data) => route(path).writeBytes(path, data),
    readLines: (path, options) => route(path).readLines(path, options),
    createExclusive: (path, data) => route(path).createExclusive(path, data),
    stat: (path) => route(path).stat(path),
    lstat: (path) => route(path).lstat(path),
    readdir: (path) => route(path).readdir(path),
    mkdir: (path, options) => route(path).mkdir(path, options),
    remove: (path) => route(path).remove(path),
    realpath: (path) => route(path).realpath(path),
  };
}

function readiness(value: unknown): Promise<void> {
  const ready = (value as { readonly ready?: unknown }).ready;
  return ready !== null && typeof ready === 'object' && 'then' in ready
    ? Promise.resolve(ready as PromiseLike<unknown>).then(() => {})
    : Promise.resolve();
}
