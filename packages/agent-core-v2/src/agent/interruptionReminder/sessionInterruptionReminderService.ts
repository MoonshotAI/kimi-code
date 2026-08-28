import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { IAgentInterruptionReminderService } from './interruptionReminder';
import { AgentInterruptionReminderService } from './interruptionReminderService';

export interface ISessionInterruptionReminderService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
}

export const ISessionInterruptionReminderService: ServiceIdentifier<ISessionInterruptionReminderService> =
  createDecorator<ISessionInterruptionReminderService>('sessionInterruptionReminderService');

interface InterruptionReminderImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentInterruptionReminderService;
}

export class SessionInterruptionReminderService extends Disposable implements ISessionInterruptionReminderService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, InterruptionReminderImplEntry>();

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
    const impl = new AgentInterruptionReminderService(
      host.eventBus,
      this.agentLifecycle,
      host.scopeContext,
      host.state,
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

function disposeImpl(impl: IAgentInterruptionReminderService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionInterruptionReminderService,
  SessionInterruptionReminderService,
  ScopeActivation.OnScopeCreated,
  'interruptionReminder',
);
