import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { IAgentSwarmService } from '../agent/swarm';
import { AgentSwarmService } from '../agent/swarmService';

export interface ISessionSwarmAgentService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentSwarmService;
}

export const ISessionSwarmAgentService: ServiceIdentifier<ISessionSwarmAgentService> =
  createDecorator<ISessionSwarmAgentService>('sessionSwarmAgentService');

interface SwarmImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentSwarmService;
}

export class SessionSwarmAgentService extends Disposable implements ISessionSwarmAgentService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, SwarmImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
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
    const impl = new AgentSwarmService(
      host.dispatcher,
      this.agentLifecycle,
      host.eventBus,
      this.toolApproval.of(agent),
      host.scopeContext,
      host.state,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentSwarmService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent swarm service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentSwarmService): void {
  (impl as Partial<IDisposable>).dispose?.();
}
