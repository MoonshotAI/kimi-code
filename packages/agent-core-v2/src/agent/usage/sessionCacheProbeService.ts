import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionUsageService } from '#/session/usage/sessionUsage';

import { IAgentCacheProbeService } from './cacheProbe';
import { AgentCacheProbeService } from './cacheProbeService';

export interface ISessionCacheProbeService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
}

export const ISessionCacheProbeService: ServiceIdentifier<ISessionCacheProbeService> =
  createDecorator<ISessionCacheProbeService>('sessionCacheProbeService');

interface CacheProbeImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentCacheProbeService;
}

export class SessionCacheProbeService extends Disposable implements ISessionCacheProbeService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, CacheProbeImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IModelCatalog private readonly models: IModelCatalog,
  ) {
    super();
    this._register(this.agentLifecycle.onDidClose((agent) => this.discard(agent)));
    this._register(
      toDisposable(() => {
        for (const entry of this.impls.values()) disposeImpl(entry.impl);
        this.impls.clear();
      }),
    );
    for (const agent of this.agentLifecycle.list()) this.attach(agent);
  }

  attach(agent: AgentContext): void {
    const host = this.hosts.of(agent);
    const existing = this.impls.get(agent.agentId);
    if (existing !== undefined && existing.host === host) return;
    if (existing !== undefined) disposeImpl(existing.impl);
    const impl = new AgentCacheProbeService(
      this.usage,
      host.scopeContext,
      host.telemetry,
      this.models,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  private discard(agent: AgentContext): void {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) return;
    this.impls.delete(agent.agentId);
    disposeImpl(entry.impl);
  }
}

function disposeImpl(impl: IAgentCacheProbeService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionCacheProbeService,
  SessionCacheProbeService,
  ScopeActivation.OnScopeCreated,
  'cacheProbe',
);
