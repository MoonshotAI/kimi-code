import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentExternalHooksService } from '../agent/agentExternalHooks';
import { AgentExternalHooksService } from '../agent/agentExternalHooksService';
import { IExternalHooksRunnerService } from '../app/externalHooksRunner';

export interface ISessionAgentExternalHooksService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentExternalHooksService;
}

export const ISessionAgentExternalHooksService: ServiceIdentifier<ISessionAgentExternalHooksService> =
  createDecorator<ISessionAgentExternalHooksService>('sessionAgentExternalHooksService');

interface ExternalHooksImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentExternalHooksService;
}

export class SessionAgentExternalHooksService extends Disposable implements ISessionAgentExternalHooksService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, ExternalHooksImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
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
    const impl = new AgentExternalHooksService(
      this.runner,
      this.agentLifecycle,
      host.eventBus,
      this.sessionContext,
      this.sessionMetadata,
      host.state,
      host.scopeContext,
      host.dispatcher,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentExternalHooksService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent external hooks service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentExternalHooksService): void {
  (impl as Partial<IDisposable>).dispose?.();
}
