import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';

import { IAgentAgentsMdReminderService } from './agentsMdReminder';
import { AgentAgentsMdReminderService } from './agentsMdReminderService';
import { ISessionAgentsMdReminderService } from './sessionAgentsMdReminder';

export { ISessionAgentsMdReminderService } from './sessionAgentsMdReminder';

interface AgentsMdReminderImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentAgentsMdReminderService;
}

export class SessionAgentsMdReminderService extends Disposable implements ISessionAgentsMdReminderService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, AgentsMdReminderImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IBashParserService private readonly bashParser: IBashParserService,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
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
    const impl = new AgentAgentsMdReminderService(
      this.agentLifecycle,
      host.scopeContext,
      host.state,
      this.sessionCtx,
      host.agentRuntime,
      this.bootstrap,
      this.bashParser,
      host.telemetry,
      host.dispatcher,
      this.instructions,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentAgentsMdReminderService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent agentsMd reminder service for '${agent.agentId}' is unavailable`);
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

function disposeImpl(impl: IAgentAgentsMdReminderService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionAgentsMdReminderService,
  SessionAgentsMdReminderService,
  ScopeActivation.OnScopeCreated,
  'agentsMdReminder',
);
