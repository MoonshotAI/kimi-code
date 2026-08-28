import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventService } from '#/app/event/event';
import { IPluginService } from '#/app/plugin/plugin';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentPluginCommandService } from './pluginCommand';
import { AgentPluginCommandService } from './pluginCommandService';

export interface ISessionPluginCommandService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentPluginCommandService;
}

export const ISessionPluginCommandService: ServiceIdentifier<ISessionPluginCommandService> =
  createDecorator<ISessionPluginCommandService>('sessionPluginCommandService');

interface PluginCommandImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentPluginCommandService;
}

export class SessionPluginCommandService extends Disposable implements ISessionPluginCommandService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, PluginCommandImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionCtx: ISessionContext,
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
    const impl = new AgentPluginCommandService(
      this.plugins,
      this.agentLifecycle,
      host.dispatcher,
      this.metadata,
      this.eventService,
      this.sessionCtx,
      host.scopeContext,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentPluginCommandService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent plugin command service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentPluginCommandService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionPluginCommandService,
  SessionPluginCommandService,
  ScopeActivation.OnScopeCreated,
  'sessionPluginCommand',
);
