import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IAgentTowerService } from './tower';
import { AgentTowerService } from './towerService';

export interface ISessionTowerService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentTowerService;
}

export const ISessionTowerService: ServiceIdentifier<ISessionTowerService> =
  createDecorator<ISessionTowerService>('sessionTowerService');

interface TowerImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentTowerService;
}

export class SessionTowerService extends Disposable implements ISessionTowerService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, TowerImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionToolApprovalService private readonly toolApproval: ISessionToolApprovalService,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IFlagService private readonly flags: IFlagService,
    @ISessionManager private readonly sessions: ISessionManager,
    @IFeatureManager private readonly featureManager: IFeatureManager,
    @IConfigService private readonly config: IConfigService,
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
    const impl = new AgentTowerService(
      host.dispatcher,
      host.state,
      this.toolApproval.of(agent),
      host.scopeContext,
      this.sessionCtx,
      this.flags,
      this.sessions,
      this.featureManager,
      this.config,
      this.agentLifecycle,
      host.eventBus,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentTowerService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent tower service for '${agent.agentId}' is unavailable`);
    }
    return entry.impl;
  }

  private discard(agent: AgentContext): void {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) return;
    this.impls.delete(agent.agentId);
    disposeImpl(entry.impl);
  }
}

function disposeImpl(impl: IAgentTowerService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTowerService,
  SessionTowerService,
  ScopeActivation.OnScopeCreated,
  'tower',
);
