import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { FiberHandle } from '#/_base/di/fiber';
import { Service } from '#/_base/di/service';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IFileService } from '#/app/file/fileService';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { AgentToolProviderContribution } from '#/agent/toolRegistry/toolContribution';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { ImageConfigBridge, IImageConfigBridge } from './imageConfigBridge';
import { IAgentMediaResolverService } from './mediaResolver';
import { AgentMediaResolverService } from './mediaResolverService';
import { IAgentMediaToolsRegistrar } from './mediaTools';
import { AgentMediaToolsRegistrar } from './mediaToolsRegistrar';
import { ISessionMediaStore } from './sessionMediaStore';

export interface ISessionMediaService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  resolverOf(agent: AgentContext): IAgentMediaResolverService;
}

export const ISessionMediaService: ServiceIdentifier<ISessionMediaService> =
  createDecorator<ISessionMediaService>('sessionMediaService');

interface MediaImplEntry {
  readonly host: AgentHost;
  readonly registrar: IAgentMediaToolsRegistrar;
  readonly bridge: IImageConfigBridge;
  readonly resolver: IAgentMediaResolverService;
  readonly contributionHandle: FiberHandle | undefined;
}

export class SessionMediaService extends Service implements ISessionMediaService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, MediaImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IFileService private readonly files: IFileService,
    @IBlobStore private readonly blobs: IBlobStore,
    @ISessionMediaStore private readonly mediaStore: ISessionMediaStore,
    @IConfigService private readonly configService: IConfigService,
  ) {
    super();
    this._register(this.agentLifecycle.onDidClose((agent) => this.discard(agent)));
    this._register(
      toDisposable(() => {
        for (const entry of this.impls.values()) disposeEntry(entry);
        this.impls.clear();
      }),
    );
    for (const agent of this.agentLifecycle.list()) this.attach(agent);
  }

  attach(agent: AgentContext): void {
    const host = this.hosts.of(agent);
    const existing = this.impls.get(agent.agentId);
    if (existing !== undefined && existing.host === host) return;
    if (existing !== undefined) disposeEntry(existing);
    const registrar = new AgentMediaToolsRegistrar(
      this.agentLifecycle,
      host.scopeContext,
      this.modelCatalog,
      host.eventBus,
      host.agentRuntime,
      this.workspaceCtx,
      host.telemetry,
      host.state,
      this.skillCatalog,
    );
    const bridge = new ImageConfigBridge(this.configService);
    const resolver = new AgentMediaResolverService(
      this.files,
      this.blobs,
      host.telemetry,
      host.state,
      this.mediaStore,
    );
    const contribution = (registrar as Partial<Pick<AgentMediaToolsRegistrar, 'contribution'>>).contribution;
    const contributionHandle =
      contribution !== undefined
        ? this.provide(AgentToolProviderContribution, contribution)
        : undefined;
    this.impls.set(agent.agentId, { host, registrar, bridge, resolver, contributionHandle });
  }

  resolverOf(agent: AgentContext): IAgentMediaResolverService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent media resolver service for '${agent.agentId}' is unavailable`);
    }
    return entry.resolver;
  }

  private discard(agent: AgentContext): void {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) return;
    this.impls.delete(agent.agentId);
    disposeEntry(entry);
  }
}

function disposeEntry(entry: MediaImplEntry): void {
  void entry.contributionHandle?.dispose();
  for (const impl of [entry.registrar, entry.bridge, entry.resolver]) {
    (impl as Partial<IDisposable>).dispose?.();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMediaService,
  SessionMediaService,
  ScopeActivation.OnScopeCreated,
  'media',
);
