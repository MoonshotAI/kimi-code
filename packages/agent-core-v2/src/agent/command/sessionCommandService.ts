import { type CollectionView } from '#/_base/di/collection';
import {
  createDecorator,
  IInstantiationService,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { IAgentCommandService } from './agentCommand';
import { AgentCommandService } from './agentCommandService';
import { CommandContribution } from './commandContribution';

export interface ISessionCommandService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentCommandService;
}

export const ISessionCommandService: ServiceIdentifier<ISessionCommandService> =
  createDecorator<ISessionCommandService>('sessionCommandService');

interface CommandImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentCommandService;
}

export class SessionCommandService extends Disposable implements ISessionCommandService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, CommandImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @CommandContribution private readonly commandContributions: CollectionView<CommandContribution>,
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
    const impl = new AgentCommandService(this.instantiation, this.commandContributions);
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentCommandService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent command service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentCommandService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionCommandService,
  SessionCommandService,
  ScopeActivation.OnScopeCreated,
  'sessionCommand',
);
