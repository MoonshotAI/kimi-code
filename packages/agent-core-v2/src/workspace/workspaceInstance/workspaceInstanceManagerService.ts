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
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { IModelService } from '#/llm-adapter/model/model';
import { IProviderService } from '#/llm-adapter/provider/provider';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { Error2, ErrorCodes } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IEnvironmentService } from '#/app/environment/environment';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { IWorkspaceTrustStore } from '#/workspace/workspaceTrust/workspaceTrustStore';

import { WorkspaceInstance } from './workspaceInstance';
import { IWorkspaceInstanceManager, type WorkspaceInstanceLease, type WorkspaceInstanceRef } from './workspaceInstanceManager';

export class WorkspaceInstanceManager implements IWorkspaceInstanceManager {
  declare readonly _serviceBrand: undefined;
  private readonly instances = new Map<string, WorkspaceInstance>();
  private readonly requests = new Map<string, Promise<Workspace>>();
  private readonly inflight = new Map<string, Promise<WorkspaceInstance>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly references = new Map<string, number>();
  private readonly changeEmitter = new Emitter<{ workspaceId: string; instance?: WorkspaceInstance }>();
  private disposing = false;
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
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
    @IModelService private readonly models: IModelService,
    @IMcpOAuthService private readonly oauth: McpOAuthService,
    @IMcpConfigStore private readonly configStore: IMcpConfigStore,
    @IPluginService private readonly plugins: IPluginService,
    @IProviderService private readonly modelProviders: IProviderService,
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
    @IWorkspacePersistence private readonly workspaceStore: IWorkspacePersistence,
    @IWorkspaceTrustStore private readonly trustStore: IWorkspaceTrustStore,
  ) {}

  get(workspaceId: string): WorkspaceInstance | undefined {
    return this.instances.get(workspaceId);
  }

  findByRoot(root: string): WorkspaceInstance | undefined {
    const normalized = root.replace(/[\\/]$/, '');
    return [...this.instances.values()].find((instance) => instance.root.replace(/[\\/]$/, '') === normalized);
  }

  findContaining(cwd: string): WorkspaceInstance | undefined {
    const probe = canonicalWorkspaceRoot(cwd);
    let best: { readonly instance: WorkspaceInstance; readonly rootLength: number } | undefined;
    for (const instance of this.instances.values()) {
      for (const dir of [instance.root, ...instance.program.dirs.additionalDirs]) {
        const root = canonicalWorkspaceRoot(dir);
        const prefix = root.endsWith('/') ? root : `${root}/`;
        if (probe !== root && !probe.startsWith(prefix)) continue;
        if (best === undefined || root.length > best.rootLength) {
          best = { instance, rootLength: root.length };
        }
      }
    }
    return best?.instance;
  }

  list(): readonly WorkspaceInstance[] {
    return [...this.instances.values()];
  }

  snapshot(): { readonly workspaces: readonly ReturnType<WorkspaceInstance['snapshot']>[] } {
    return { workspaces: this.list().map((instance) => instance.snapshot()) };
  }

  acquire(ref: WorkspaceInstanceRef): Promise<WorkspaceInstanceLease> {
    if (this.disposing) return Promise.reject(new Error('workspace instance manager is disposing'));
    const key = 'workspaceId' in ref
      ? `id:${ref.workspaceId}`
      : `root:${ref.root.replace(/[\\/]$/, '')}`;
    let request = this.requests.get(key);
    if (request === undefined) {
      const pending: Promise<Workspace> = this.resolveWorkspace(ref).finally(() => {
        if (this.requests.get(key) === pending) this.requests.delete(key);
      });
      this.requests.set(key, pending);
      request = pending;
    }
    return request.then((workspace) => this.acquireWorkspace(workspace));
  }

  private async resolveWorkspace(ref: WorkspaceInstanceRef): Promise<Workspace> {
    let workspace: Workspace | undefined;
    if ('workspaceId' in ref) {
      workspace = await this.workspaces.get(ref.workspaceId);
      if (workspace === undefined && ref.root !== undefined) workspace = await this.workspaces.createOrTouch(ref.root);
    } else {
      workspace = await this.workspaces.createOrTouch(ref.root);
    }
    if (workspace === undefined) throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `workspace ${'workspaceId' in ref ? ref.workspaceId : ref.root} does not exist`);
    return workspace;
  }

  private async acquireWorkspace(workspace: Workspace): Promise<WorkspaceInstanceLease> {
    while (!this.disposing) {
      const existing = this.instances.get(workspace.id);
      if (existing !== undefined) {
        if (workspaceRootKey(existing.root) === workspaceRootKey(workspace.root)) {
          return this.retain(existing);
        }
        await this.close(existing);
        continue;
      }
      const closing = this.closing.get(workspace.id);
      if (closing !== undefined) {
        await closing;
        continue;
      }
      let pending = this.inflight.get(workspace.id);
      if (pending === undefined) {
        const materialization: Promise<WorkspaceInstance> = this.materialize(workspace).finally(() => {
          if (this.inflight.get(workspace.id) === materialization) this.inflight.delete(workspace.id);
        });
        this.inflight.set(workspace.id, materialization);
        pending = materialization;
      }
      await pending;
    }
    throw new Error('workspace instance manager is disposing');
  }

  private retain(instance: WorkspaceInstance): WorkspaceInstanceLease {
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

  private release(instance: WorkspaceInstance): void {
    if (this.instances.get(instance.id) !== instance) return;
    const references = this.references.get(instance.id);
    if (references === undefined) return;
    if (references > 1) {
      this.references.set(instance.id, references - 1);
      return;
    }
    void this.close(instance);
  }

  private close(instance: WorkspaceInstance): Promise<void> {
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
    await Promise.allSettled([
      ...this.requests.values(),
      ...this.inflight.values(),
      ...this.closing.values(),
    ]);
    for (const instance of [...this.instances.values()].toReversed()) await this.close(instance);
    this.changeEmitter.dispose();
  }

  private async materialize(workspace: Workspace): Promise<WorkspaceInstance> {
    await this.environment.ready;
    await this.environments.ready;
    const instance = new WorkspaceInstance(
      workspace,
      this.environments,
      {
        _serviceBrand: undefined,
        workspaceId: workspace.id,
        cwd: workspace.root,
        source: 'local',
        meta: workspace,
        persistenceScope: `${this.bootstrap.scope('sessions')}/${workspace.id}`,
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
        workspaces: this.workspaces,
        workspaceStore: this.workspaceStore,
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
          input.extraAgentProfiles,
          input.explicitAgentProfiles,
          input.userAgentProfiles,
          input.pluginAgentProfiles,
          input.mcp,
          this.models,
          this.modelProviders,
          this.environments,
          input.acquireWorkdir,
          input.onDispose,
        ),
      },
    );
    try {
      instance.activate();
      this.instances.set(workspace.id, instance);
      this.changeEmitter.fire({ workspaceId: workspace.id, instance });
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

  private async disposeInstance(instance: WorkspaceInstance): Promise<void> {
    try {
      await instance.dispose();
    } catch (error) {
      this.log.error('workspace disposal failed', { workspaceId: instance.id, error });
    }
  }
}

registerScopedService(LifecycleScope.App, IWorkspaceInstanceManager, WorkspaceInstanceManager, ScopeActivation.OnScopeCreated, 'workspaceInstanceManager');
