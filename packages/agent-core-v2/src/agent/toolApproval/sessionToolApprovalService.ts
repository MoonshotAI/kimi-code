import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IAgentToolApprovalService } from './toolApproval';
import { AgentToolApprovalService } from './toolApprovalService';

export interface ISessionToolApprovalService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentToolApprovalService;
}

export const ISessionToolApprovalService: ServiceIdentifier<ISessionToolApprovalService> =
  createDecorator<ISessionToolApprovalService>('sessionToolApprovalService');

interface ToolApprovalImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentToolApprovalService;
}

export class SessionToolApprovalService extends Disposable implements ISessionToolApprovalService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, ToolApprovalImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @ISessionApprovalService private readonly approval?: ISessionApprovalService,
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
    const impl = new AgentToolApprovalService(
      host.scopeContext,
      this.sessionCtx,
      host.telemetry,
      host.dispatcher,
      this.agentLifecycle,
      this.approval,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentToolApprovalService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent tool approval service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentToolApprovalService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionToolApprovalService,
  SessionToolApprovalService,
  ScopeActivation.OnScopeCreated,
  'sessionToolApproval',
);
