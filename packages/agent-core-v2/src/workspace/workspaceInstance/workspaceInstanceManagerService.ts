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
import { IModelService } from '#/llm-adapter/model/model';
import { IProviderService } from '#/llm-adapter/provider/provider';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { Error2, ErrorCodes } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IEnvironmentService } from '#/app/environment/environment';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';

import { WorkspaceInstance } from './workspaceInstance';
import { IWorkspaceInstanceManager, type WorkspaceInstanceRef } from './workspaceInstanceManager';

export class WorkspaceInstanceManager implements IWorkspaceInstanceManager {
  declare readonly _serviceBrand: undefined;
  private readonly instances = new Map<string, WorkspaceInstance>();
  private readonly requests = new Map<string, Promise<WorkspaceInstance>>();
  private readonly inflight = new Map<string, Promise<WorkspaceInstance>>();
  private readonly changeEmitter = new Emitter<{ workspaceId: string; instance?: WorkspaceInstance }>();
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
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IEnvironmentService private readonly environments: IEnvironmentService,
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
      const root = canonicalWorkspaceRoot(instance.root);
      const prefix = root.endsWith('/') ? root : `${root}/`;
      if (probe !== root && !probe.startsWith(prefix)) continue;
      if (best === undefined || root.length > best.rootLength) {
        best = { instance, rootLength: root.length };
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

  async getOrCreate(ref: WorkspaceInstanceRef): Promise<WorkspaceInstance> {
    const key = 'workspaceId' in ref
      ? `id:${ref.workspaceId}`
      : `root:${ref.root.replace(/[\\/]$/, '')}`;
    const request = this.requests.get(key);
    if (request !== undefined) return request;
    const promise = (async () => {
      let workspace: Workspace | undefined;
      if ('workspaceId' in ref) {
        workspace = await this.workspaces.get(ref.workspaceId);
        if (workspace === undefined && ref.root !== undefined) workspace = await this.workspaces.createOrTouch(ref.root);
      } else {
        workspace = await this.workspaces.createOrTouch(ref.root);
      }
      if (workspace === undefined) throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `workspace ${'workspaceId' in ref ? ref.workspaceId : ref.root} does not exist`);
      const existing = this.instances.get(workspace.id);
      if (existing !== undefined) return existing;
      const pending = this.inflight.get(workspace.id);
      if (pending !== undefined) return pending;
      const materialization = this.materialize(workspace).finally(() => this.inflight.delete(workspace.id));
      this.inflight.set(workspace.id, materialization);
      return materialization;
    })().finally(() => this.requests.delete(key));
    this.requests.set(key, promise);
    return promise;
  }

  async close(workspaceId: string): Promise<void> {
    const pending = this.requests.get(`id:${workspaceId}`) ?? this.inflight.get(workspaceId);
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        return;
      }
    }
    const instance = this.instances.get(workspaceId);
    if (instance === undefined) return;
    this.instances.delete(workspaceId);
    await instance.dispose();
    this.changeEmitter.fire({ workspaceId });
  }

  async dispose(): Promise<void> {
    for (const workspaceId of [...this.instances.keys()].toReversed()) await this.close(workspaceId);
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
        createSessionController: (input) => new SessionLifecycleService(
          this.instantiation,
          input.context,
          this.bootstrap,
          this.config,
          this.index,
          this.indexMirror,
          this.appendLogStore,
          this.docs,
          this.storage,
          this.log,
          this.hostFs,
          this.event,
          this.telemetry,
          this.flags,
          input.workspaceAgentProfiles,
          input.extraAgentProfiles,
          input.explicitAgentProfiles,
          input.userAgentProfiles,
          input.pluginAgentProfiles,
          input.dirs,
          input.skills,
          input.instructions,
          input.mcp,
          this.models,
          this.modelProviders,
          input.environments,
          input.onDispose,
          input.profileContextKey,
        ),
      },
    );
    instance.activate();
    this.instances.set(workspace.id, instance);
    this.changeEmitter.fire({ workspaceId: workspace.id, instance });
    return instance;
  }
}

registerScopedService(LifecycleScope.App, IWorkspaceInstanceManager, WorkspaceInstanceManager, ScopeActivation.OnScopeCreated, 'workspaceInstanceManager');
