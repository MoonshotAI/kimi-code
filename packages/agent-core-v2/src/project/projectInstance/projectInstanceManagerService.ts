import { IInstantiationService, ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { IFlagService } from '#/app/flag/flag';
import { IGitService } from '#/app/git/git';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IBuiltinSkillSource } from '#/features/skill/catalog/builtinSkillSource';
import { IUserFileSkillSource } from '#/features/skill/catalog/userFileSkillSource';
import { IAppStateService } from '#/app/state/appState';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { LifecycleScope } from '#/app/scopes';
import { IProjectService, type Project } from '#/app/project/project';
import { IProjectPersistence } from '#/app/project/projectPersistence';

import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { Error2, ErrorCodes } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IEnvironmentService } from '#/app/environment/environment';
import { canonicalProjectRoot } from '#/_base/utils/paths';
import { SessionLifecycleService } from '#/project/sessionLifecycle/sessionLifecycleService';
import { IProjectTrustStore } from '#/project/projectTrust/projectTrustStore';

import { ProjectInstance } from './projectInstance';
import { IProjectInstanceManager, type ProjectInstanceLease, type ProjectInstanceRef } from './projectInstanceManager';
import { IProviderCatalogService } from '#/provider-catalog/providerCatalogService';

export class ProjectInstanceManager implements IProjectInstanceManager {
  declare readonly _serviceBrand: undefined;
  private readonly instances = new Map<string, ProjectInstance>();
  private readonly requests = new Map<string, Promise<Project>>();
  private readonly inflight = new Map<string, Promise<ProjectInstance>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly references = new Map<string, number>();
  private readonly changeEmitter = new Emitter<{ workspaceId: string; instance?: ProjectInstance }>();
  private disposing = false;
  readonly onDidChange = this.changeEmitter.event;
  private readonly workspaceStoreSubscription: { dispose(): void };

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IProjectService private readonly projects: IProjectService,
    @IHostEnvironment private readonly environment: IHostEnvironment,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IAppStateService private readonly appState: IAppStateService,
    @IConfigService private readonly config: IConfigService,
    @IEventService private readonly event: IEventService,
    @ref(IGitService) private readonly git: LiveRef<IGitService>,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionIndexMirror private readonly indexMirror: ISessionIndexMirror,
    @ILogService private readonly log: ILogService,
    @IProviderCatalogService private readonly models: IProviderCatalogService,
    @IMcpOAuthService private readonly oauth: McpOAuthService,
    @IMcpConfigStore private readonly configStore: IMcpConfigStore,
    @IPluginService private readonly plugins: IPluginService,
    @IProviderCatalogService private readonly modelProviders: IProviderCatalogService,
    @ref(ISessionManager) private readonly sessionManager: LiveRef<ISessionManager>,
    @IAgentProfileRegistry private readonly agentProfiles: IAgentProfileRegistry,
    @IBuiltinAgentProfileLoader private readonly builtinAgentProfiles: IBuiltinAgentProfileLoader,
    @IBuiltinSkillSource private readonly builtinSkills: IBuiltinSkillSource,
    @IUserFileSkillSource private readonly userSkills: IUserFileSkillSource,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IFlagService private readonly flags: IFlagService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @ISessionLockService private readonly sessionLocks: ISessionLockService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IEnvironmentService private readonly environments: IEnvironmentService,
    @IProjectPersistence private readonly projectStore: IProjectPersistence,
    @IProjectTrustStore private readonly trustStore: IProjectTrustStore,
  ) {
    this.workspaceStoreSubscription = this.projectStore.onDidChange(() => {
      for (const instance of this.instances.values()) {
        void this.projects.get(instance.id).then((workspace) => {
          if (workspace !== undefined && this.instances.get(instance.id) === instance) {
            instance.update(workspace);
          }
        }).catch((error) => {
          this.log.warn('workspace metadata refresh failed', { workspaceId: instance.id, error });
        });
      }
    });
  }

  get(workspaceId: string): ProjectInstance | undefined {
    return this.instances.get(workspaceId);
  }

  findByRoot(root: string): ProjectInstance | undefined {
    const normalized = root.replace(/[\\/]$/, '');
    return [...this.instances.values()].find((instance) => instance.root.replace(/[\\/]$/, '') === normalized);
  }

  findContaining(cwd: string): ProjectInstance | undefined {
    const probe = canonicalProjectRoot(cwd);
    let best: { readonly instance: ProjectInstance; readonly rootLength: number } | undefined;
    for (const instance of this.instances.values()) {
      for (const dir of [instance.root, ...instance.program.dirs.additionalDirs]) {
        const root = canonicalProjectRoot(dir);
        const prefix = root.endsWith('/') ? root : `${root}/`;
        if (probe !== root && !probe.startsWith(prefix)) continue;
        if (best === undefined || root.length > best.rootLength) {
          best = { instance, rootLength: root.length };
        }
      }
    }
    return best?.instance;
  }

  list(): readonly ProjectInstance[] {
    return [...this.instances.values()];
  }

  snapshot(): { readonly workspaces: readonly ReturnType<ProjectInstance['snapshot']>[] } {
    return { workspaces: this.list().map((instance) => instance.snapshot()) };
  }

  acquire(ref: ProjectInstanceRef): Promise<ProjectInstanceLease> {
    if (this.disposing) return Promise.reject(new Error('workspace instance manager is disposing'));
    const key = 'workspaceId' in ref
      ? `id:${ref.workspaceId}`
      : `cwd:${ref.cwd.replace(/[\\/]$/, '')}`;
    let request = this.requests.get(key);
    if (request === undefined) {
      const pending: Promise<Project> = this.resolveWorkspace(ref).finally(() => {
        if (this.requests.get(key) === pending) this.requests.delete(key);
      });
      this.requests.set(key, pending);
      request = pending;
    }
    return request.then((workspace) => this.acquireWorkspace(workspace));
  }

  private async resolveWorkspace(ref: ProjectInstanceRef): Promise<Project> {
    if ('cwd' in ref) return this.projects.resolveImplicit(ref.cwd);
    const workspace = await this.projects.get(ref.workspaceId);
    if (workspace !== undefined) return workspace;
    if (ref.reviveFrom !== undefined) return this.projects.reviveImplicit(ref.workspaceId, ref.reviveFrom);
    throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `workspace ${ref.workspaceId} does not exist`);
  }

  private async acquireWorkspace(project: Project): Promise<ProjectInstanceLease> {
    while (!this.disposing) {
      const existing = this.instances.get(project.id);
      if (existing !== undefined) {
        existing.update(project);
        return this.retain(existing);
      }
      const closing = this.closing.get(project.id);
      if (closing !== undefined) {
        await closing;
        continue;
      }
      let pending = this.inflight.get(project.id);
      if (pending === undefined) {
        const materialization: Promise<ProjectInstance> = this.materialize(project).finally(() => {
          if (this.inflight.get(project.id) === materialization) this.inflight.delete(project.id);
        });
        this.inflight.set(project.id, materialization);
        pending = materialization;
      }
      await pending;
    }
    throw new Error('workspace instance manager is disposing');
  }

  private retain(instance: ProjectInstance): ProjectInstanceLease {
    this.references.set(instance.id, (this.references.get(instance.id) ?? 0) + 1);
    let released = false;
    return {
      instance,
      dispose: () => {
        if (released) return;
        released = true;
        this.release(instance);
      },
    };
  }

  private release(instance: ProjectInstance): void {
    if (this.instances.get(instance.id) !== instance) return;
    const references = this.references.get(instance.id);
    if (references === undefined) return;
    if (references > 1) {
      this.references.set(instance.id, references - 1);
      return;
    }
    void this.close(instance);
  }

  private close(instance: ProjectInstance): Promise<void> {
    if (this.instances.get(instance.id) !== instance) {
      return this.closing.get(instance.id) ?? Promise.resolve();
    }
    this.instances.delete(instance.id);
    this.references.delete(instance.id);
    const pending: Promise<void> = this.disposeInstance(instance).then(() => {
      if (this.closing.get(instance.id) === pending) this.closing.delete(instance.id);
      try {
        this.changeEmitter.fire({ workspaceId: instance.id });
      } catch (error) {
        this.log.error('workspace change notification failed', { workspaceId: instance.id, error });
      }
    });
    this.closing.set(instance.id, pending);
    return pending;
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.workspaceStoreSubscription.dispose();
    await Promise.allSettled([
      ...this.requests.values(),
      ...this.inflight.values(),
      ...this.closing.values(),
    ]);
    for (const instance of [...this.instances.values()].toReversed()) await this.close(instance);
    this.changeEmitter.dispose();
  }

  private async materialize(project: Project): Promise<ProjectInstance> {
    await this.environment.ready;
    await this.environments.ready;
    const instance = new ProjectInstance(
      project,
      this.environments,
      {
        _serviceBrand: undefined,
        workspaceId: project.id,
        cwd: project.root,
        source: 'local',
        meta: project,
        persistenceScope: `${this.bootstrap.scope('sessions')}/${project.id}`,
      },
      {
        appState: this.appState,
        bootstrap: this.bootstrap,
        config: this.config,
        git: this.git,
        identity: this.identity,
        log: this.log,
        oauth: this.oauth,
        configStore: this.configStore,
        plugins: this.plugins,
        sessionManager: this.sessionManager,
        agentProfiles: this.agentProfiles,
        builtinAgentProfiles: this.builtinAgentProfiles,
        builtinSkills: this.builtinSkills,
        userSkills: this.userSkills,
        telemetry: this.telemetry,
        docs: this.docs,
        workspaces: this.projects,
        workspaceStore: this.projectStore,
        trustStore: this.trustStore,
        createSessionController: (input) => new SessionLifecycleService(
          this.instantiation,
          input.context,
          this.bootstrap,
          this.config,
          this.index,
          this.indexMirror,
          this.appendLogStore,
          this.sessionLocks,
          this.docs,
          this.storage,
          this.log,
          this.hostFs,
          this.event,
          this.telemetry,
          this.flags,
          input.userAgentProfiles,
          input.pluginAgentProfiles,
          input.acquireMcp,
          this.models,
          this.modelProviders,
          this.environments,
          input.trust,
          input.acquireWorkdir,
          input.onDispose,
        ),
      },
    );
    try {
      instance.activate();
      this.instances.set(project.id, instance);
      this.changeEmitter.fire({ workspaceId: project.id, instance });
      return instance;
    } catch (error) {
      if (this.instances.get(instance.id) === instance) {
        this.instances.delete(instance.id);
        this.references.delete(instance.id);
      }
      await this.disposeInstance(instance);
      throw error;
    }
  }

  private async disposeInstance(instance: ProjectInstance): Promise<void> {
    try {
      await instance.dispose();
    } catch (error) {
      this.log.error('workspace disposal failed', { workspaceId: instance.id, error });
    }
  }
}

registerScopedService(LifecycleScope.App, IProjectInstanceManager, ProjectInstanceManager, ScopeActivation.OnScopeCreated, 'workspaceInstanceManager');
