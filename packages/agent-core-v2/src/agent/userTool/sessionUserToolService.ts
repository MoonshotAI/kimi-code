import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { FiberHandle } from '#/_base/di/fiber';
import { Service } from '#/_base/di/service';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { AgentToolProviderContribution } from '#/agent/toolRegistry/toolContribution';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { IAgentUserToolService } from './userTool';
import { AgentUserToolService } from './userToolService';

export interface ISessionUserToolService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentUserToolService;
}

export const ISessionUserToolService: ServiceIdentifier<ISessionUserToolService> =
  createDecorator<ISessionUserToolService>('sessionUserToolService');

interface UserToolImplEntry {
  readonly host: AgentHost;
  readonly impl: AgentUserToolService;
  readonly contributionHandle: FiberHandle | undefined;
}

export class SessionUserToolService extends Service implements ISessionUserToolService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, UserToolImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
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
    const impl = new AgentUserToolService(
      host.scopeContext,
      this.agentLifecycle,
      host.dispatcher,
      host.state,
    );
    const contributionHandle =
      impl.contribution !== undefined
        ? this.provide(AgentToolProviderContribution, impl.contribution)
        : undefined;
    this.impls.set(agent.agentId, { host, impl, contributionHandle });
  }

  of(agent: AgentContext): IAgentUserToolService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent user tool service for '${agent.agentId}' is unavailable`);
    }
    return entry.impl;
  }

  private discard(agent: AgentContext): void {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) return;
    this.impls.delete(agent.agentId);
    disposeEntry(entry);
  }
}

function disposeEntry(entry: UserToolImplEntry): void {
  void entry.contributionHandle?.dispose();
  (entry.impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionUserToolService,
  SessionUserToolService,
  ScopeActivation.OnScopeCreated,
  'sessionUserTool',
);
