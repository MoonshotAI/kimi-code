import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { ISessionTaskService } from '#/agent/task/sessionTaskService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { IAgentActivityView } from './activityView';
import { AgentActivityView } from './activityViewService';

export interface ISessionActivityViewService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentActivityView;
}

export const ISessionActivityViewService: ServiceIdentifier<ISessionActivityViewService> =
  createDecorator<ISessionActivityViewService>('sessionActivityViewService');

interface ActivityViewImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentActivityView;
}

export class SessionActivityViewService extends Disposable implements ISessionActivityViewService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, ActivityViewImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionTaskService private readonly tasks: ISessionTaskService,
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
    const impl = new AgentActivityView(
      host.eventBus,
      this.tasks.of(agent),
      this.agentLifecycle,
      host.state,
      host.dispatcher,
      host.scopeContext,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentActivityView {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent activity view for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentActivityView): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionActivityViewService,
  SessionActivityViewService,
  ScopeActivation.OnScopeCreated,
  'sessionActivityView',
);
