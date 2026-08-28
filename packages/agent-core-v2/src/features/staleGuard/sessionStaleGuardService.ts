import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { IStaleGuardService } from './staleGuard';
import { StaleGuardService } from './staleGuardService';

export interface ISessionStaleGuardService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IStaleGuardService;
}

export const ISessionStaleGuardService: ServiceIdentifier<ISessionStaleGuardService> =
  createDecorator<ISessionStaleGuardService>('sessionStaleGuardService');

interface StaleGuardImplEntry {
  readonly host: AgentHost;
  readonly impl: IStaleGuardService;
}

export class SessionStaleGuardService extends Disposable implements ISessionStaleGuardService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, StaleGuardImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
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
    const impl = new StaleGuardService(
      host.state,
      host.dispatcher,
      host.agentRuntime,
      this.agentLifecycle,
      host.scopeContext,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IStaleGuardService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent stale guard service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IStaleGuardService): void {
  (impl as Partial<IDisposable>).dispose?.();
}
