import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IAgentPlanService } from './plan';
import { AgentPlanService } from './planService';

export interface ISessionPlanService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentPlanService;
}

export const ISessionPlanService: ServiceIdentifier<ISessionPlanService> =
  createDecorator<ISessionPlanService>('sessionPlanService');

interface PlanImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentPlanService;
}

export class SessionPlanService extends Disposable implements ISessionPlanService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, PlanImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IBlobStore private readonly blobs: IBlobStore,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @ISessionToolApprovalService private readonly toolApproval: ISessionToolApprovalService,
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
    const impl = new AgentPlanService(
      this.hostFs,
      this.blobs,
      this.agentLifecycle,
      host.telemetryContext,
      host.eventBus,
      host.dispatcher,
      this.sessionCtx,
      host.scopeContext,
      this.toolApproval.of(agent),
      host.telemetry,
      host.state,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentPlanService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent plan service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentPlanService): void {
  (impl as Partial<IDisposable>).dispose?.();
}
