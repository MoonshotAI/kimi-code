import { Emitter, type Event } from '#/_base/event';
import type { EnvironmentBinding } from '#/environment/environment';
import { LOCAL_ENVIRONMENT_ID, environmentBindingId } from '#/environment/environment';
import { EnvironmentError, type EnvironmentGenerationSnapshot, type EnvironmentRegistryChange } from '#/environment/environmentRegistry';
import type { SessionLifecycleService } from '#/project/sessionLifecycle/sessionLifecycleService';
import type { IProjectStateService } from '#/project/state/projectState';
import type { IProjectContext } from '#/project/projectContext/projectContext';
import type { IProjectDirs } from '#/project/projectDirs/projectDirs';
import type { IProjectFsService } from '#/project/projectFs/fs';
import type { IProjectGitService } from '#/project/projectGit/projectGit';
import type { IProjectInstructionsService } from '#/project/projectInstructions/projectInstructions';
import type { IProjectTrust } from '#/project/projectTrust/projectTrust';
import { ProjectTrustService } from '#/project/projectTrust/projectTrustService';
import type { IProjectTrustDisclosure } from '#/project/projectTrust/trustDisclosure';
import { ProjectTrustDisclosureService } from '#/project/projectTrust/trustDisclosureService';
import type { IPluginAgentProfileLoader } from '#/project/projectAgentProfileLoader/pluginAgentProfileLoader';
import { PluginAgentProfileLoaderService } from '#/project/projectAgentProfileLoader/pluginAgentProfileLoaderService';
import type { IUserAgentProfileLoader } from '#/project/projectAgentProfileLoader/userAgentProfileLoader';
import { UserAgentProfileLoaderService } from '#/project/projectAgentProfileLoader/userAgentProfileLoaderService';
import type { IProjectAgentProfileLoader } from '#/project/projectAgentProfileLoader/projectAgentProfileLoader';
import { PluginSkillSource } from '#/features/skill/project/pluginSkillSource';
import { EnvironmentSkillDiscovery } from '#/features/skill/project/environmentSkillDiscovery';
import type { IProjectSkillCatalog } from '#/features/skill/project/projectSkillCatalog';
import { isVisibleAgentProfileSource } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { IEnvironmentService } from '#/app/environment/environment';

import type { ProgramDependencies } from './programDependencies';
import type { ProgramMcpLease } from './programMcp';
import { ProgramMcpSets } from './programMcpSets';
import {
  PROGRAM_CAPABILITIES,
  ProgramWorkdirs,
  configuredSourcesContextKey,
  type ProgramDisclosedWorkdir,
  type ProgramHarness,
  type ProgramWorkdir,
} from './programWorkdirs';

export type { ProgramDisclosedWorkdir, ProgramWorkdir } from './programWorkdirs';

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

interface ProgramGeneration extends ProgramHarness {
  readonly id: string;
  readonly workdirs: ProgramWorkdirs;
  readonly mcp: ProgramMcpSets;
  readonly trust: IProjectTrust;
  readonly pluginAgentProfiles: IPluginAgentProfileLoader;
  readonly disposables: readonly { dispose(): void | Promise<void> }[];
  ready: boolean;
  failed: boolean;
  references: number;
  retired: boolean;
}

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
    private readonly context: IProjectContext,
    private readonly dependencies: ProgramDependencies,
  ) {
    this.registrySubscription = environments.onDidChange((change) => this.onEnvironmentChange(change));
    this.reconcileGeneration();
  }

  get status(): ProgramStatus { return this.currentStatus; }
  get state(): IProjectStateService { return this.requireGeneration().workdirs.project.state; }
  get dirs(): IProjectDirs { return this.requireGeneration().workdirs.project.dirs; }
  get fs(): IProjectFsService { return this.requireGeneration().workdirs.root.fs; }
  get git(): IProjectGitService { return this.requireGeneration().workdirs.root.git; }
  get instructions(): IProjectInstructionsService { return this.requireGeneration().workdirs.root.instructions; }
  get trust(): IProjectTrust { return this.requireGeneration().trust; }
  get skills(): IProjectSkillCatalog { return this.requireGeneration().workdirs.root.skills; }
  get agentProfiles(): IProjectAgentProfileLoader { return this.requireGeneration().workdirs.root.agentProfiles; }
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
        userAgentProfiles: generation.userAgentProfiles,
        pluginAgentProfiles: generation.pluginAgentProfiles,
        acquireMcp: (workDir) => generation.mcp.acquire(workDir),
        trust: generation.trust,
        acquireWorkdir: (environmentId, cwd, followsPrimary, launchDir) => generation.workdirs.acquire(environmentId, cwd, followsPrimary, launchDir),
        onDispose: release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  async acquireWorkdir(
    environmentId: string,
    cwd: string,
    followsPrimary = environmentId === LOCAL_ENVIRONMENT_ID,
    launchDir?: string,
  ): Promise<ProgramDisclosedWorkdir> {
    const generation = this.requireGeneration();
    const lease = await this.environments.acquireWhenReady({ environmentId }, ['fs']);
    try {
      const view = await generation.workdirs.acquire(environmentId, cwd, followsPrimary, launchDir);
      return { ...view, trustDisclosure: this.trustDisclosureOf(view, generation.trust) };
    } finally {
      lease.dispose();
    }
  }

  async acquireMcp(workDir?: string): Promise<ProgramMcpLease> {
    return this.requireGeneration().mcp.acquire(workDir);
  }

  async effectiveMcpWorkDir(workDir?: string): Promise<string> {
    return this.requireGeneration().mcp.effectiveWorkDir(workDir);
  }

  async reload(requestedBy: Partial<EnvironmentBinding> = {}, launchDir?: string): Promise<void> {
    const generation = this.requireGeneration();
    await generation.workdirs.reload(requestedBy, launchDir);
    await generation.userAgentProfiles.reload().catch(() => undefined);
  }

  waitForPluginAgentProfiles(): Promise<void> {
    return this.requireGeneration().pluginAgentProfiles.ready;
  }

  snapshot(): ProgramSnapshot {
    const generation = this.generation;
    const root = generation?.workdirs.openedRoot;
    const skills = root?.skills.catalog.listSkills() ?? [];
    const skillsBySource = new Map<string, number>();
    for (const skill of skills) {
      skillsBySource.set(skill.source, (skillsBySource.get(skill.source) ?? 0) + 1);
    }
    const viewer = { workspaceKey: this.workspaceId, contextKeys: [this.rootKey, configuredSourcesContextKey(this.rootKey)] };
    const agentProfiles = this.dependencies.agentProfiles.entries()
      .filter((entry) => isVisibleAgentProfileSource(entry, viewer))
      .map((entry) => ({
        sourceId: entry.sourceId,
        priority: entry.priority,
        profiles: entry.contribution.profiles.map((profile) => profile.name),
      }));
    const mcpServers = Object.keys(generation?.mcp.servers() ?? {});
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
          invocable: root?.skills.catalog.listInvocableSkills().length ?? 0,
          skipped: root?.skills.catalog.getSkippedByPolicy().length ?? 0,
        },
        agentProfiles: agentProfiles.reduce((total, source) => total + source.profiles.length, 0),
        mcpServers: mcpServers.length,
      },
      sources: {
        skills: [...skillsBySource].map(([source, count]) => ({ source, count })),
        skillRoots: root?.skills.catalog.getSkillRoots() ?? [],
        agentProfiles,
        instructionPaths: root?.instructions.snapshot.agentsMdPaths ?? [],
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
      const pluginSkills = new PluginSkillSource(skillDiscovery, this.dependencies.plugins);
      const userAgentProfiles = own(new UserAgentProfileLoaderService(this.dependencies.bootstrap, hostFs, this.dependencies.log, this.dependencies.builtinAgentProfiles, this.context, this.dependencies.agentProfiles));
      const pluginAgentProfiles = own(new PluginAgentProfileLoaderService(this.dependencies.plugins, hostFs, this.dependencies.log, userAgentProfiles, this.context, this.dependencies.agentProfiles));
      const harness: ProgramHarness = { userAgentProfiles, pluginSkills };
      const workdirs = new ProgramWorkdirs(this.environments, this.context, this.dependencies, harness, own);
      const { dirs, state } = workdirs.project;
      const trust = own(new ProjectTrustService(dirs, this.dependencies.trustStore, state, this.dependencies.config));
      const mcp = own(new ProgramMcpSets(this.environments, this.context, this.dependencies, hostFs, dirs, trust));
      own(workdirs);
      return {
        id: environment.identity.generation,
        workdirs,
        mcp,
        trust,
        ...harness,
        pluginAgentProfiles,
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

  private trustDisclosureOf(view: ProgramWorkdir, trust: IProjectTrust): IProjectTrustDisclosure {
    return new ProjectTrustDisclosureService(
      { workspaceKey: this.workspaceId, contextKeys: [view.contextKey, view.configuredSources.contextKey] },
      view.hostFs,
      this.dependencies.bootstrap,
      this.dependencies.config,
      view.localConfig,
      view.dirs,
      trust,
      view.skills,
      view.agentProfiles,
      this.dependencies.agentProfiles,
      view.instructions,
      this.dependencies.log,
    );
  }

  private observeReadiness(generation: ProgramGeneration): void {
    void generation.workdirs.project.dirs.ready.then(
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
