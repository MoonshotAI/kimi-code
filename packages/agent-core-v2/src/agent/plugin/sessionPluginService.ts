import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { IPluginService } from '#/app/plugin/plugin';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IAgentPluginService } from './agentPlugin';
import { AgentPluginService } from './agentPluginService';

export interface ISessionPluginService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentPluginService;
}

export const ISessionPluginService: ServiceIdentifier<ISessionPluginService> =
  createDecorator<ISessionPluginService>('sessionPluginService');

interface PluginImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentPluginService;
}

export class SessionPluginService extends Disposable implements ISessionPluginService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, PluginImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @ILogService private readonly log: ILogService,
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
    const impl = new AgentPluginService(
      host.scopeContext,
      this.agentLifecycle,
      this.plugins,
      this.skillCatalog,
      this.sessionCtx,
      this.log,
      host.state,
      host.dispatcher,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentPluginService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent plugin service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentPluginService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionPluginService,
  SessionPluginService,
  ScopeActivation.OnScopeCreated,
  'sessionPlugin',
);
