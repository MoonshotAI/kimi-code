/**
 * `gateway` domain (L7) — `IRestGateway` / `IWSGateway` implementations.
 *
 * Owns the REST/WS entry points; resolves sessions through `session-lifecycle`,
 * agents through `agent-lifecycle`, drives turns through `turn`, and flushes
 * logs through `log`. Bound at App scope.
 *
 * WS event fan-out (sequencing, journaling, replay, per-connection dispatch)
 * is a transport concern and lives in the edge package (`packages/server-v2`)
 * on top of `IEventService` + `IAgentRecordService` — not here.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agent-lifecycle/agentLifecycle';
import { IAgentRecordService } from '#/agent/record';
import { ILogService, ISessionLogService } from '#/app/log';
import { IAgentPromptService } from '#/agent/prompt';
import { ISessionLifecycleService } from '#/app/session-lifecycle';
import { IAgentTurnService } from '#/agent/turn';

import { IRestGateway, IWSGateway } from './gateway';

export class RestGateway implements IRestGateway {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionLifecycleService private readonly sessions: ISessionLifecycleService,
    @ILogService private readonly log: ILogService,
  ) {}

  private agent(sessionId: string, agentId: string): IAgentScopeHandle {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`unknown session '${sessionId}'`);
    const agents = session.accessor.get(IAgentLifecycleService);
    const agent = agents.getHandle(agentId);
    if (agent === undefined) throw new Error(`unknown agent '${agentId}'`);
    return agent;
  }

  prompt(
    sessionId: string,
    agentId: string,
    input: string,
  ): Promise<{ readonly turn_id: number } | undefined> {
    const turn = this.agent(sessionId, agentId).accessor.get(IAgentPromptService).prompt({
      role: 'user',
      content: [{ type: 'text', text: input }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    return Promise.resolve(turn === undefined ? undefined : { turn_id: turn.id });
  }
  steer(
    sessionId: string,
    agentId: string,
    content: string,
  ): Promise<{ readonly turn_id: number } | undefined> {
    const agent = this.agent(sessionId, agentId);
    const turn = agent.accessor.get(IAgentPromptService).steer({
      role: 'user',
      content: [{ type: 'text', text: content }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    const id = turn?.id ?? agent.accessor.get(IAgentTurnService).getActiveTurn()?.id;
    return Promise.resolve(id === undefined ? undefined : { turn_id: id });
  }
  cancel(sessionId: string, agentId: string, reason?: string): Promise<void> {
    const activeTurn = this.agent(sessionId, agentId).accessor.get(IAgentTurnService).getActiveTurn();
    activeTurn?.abortController.abort(reason);
    return Promise.resolve();
  }
  getStatus(sessionId: string): Promise<unknown> {
    return Promise.resolve(this.sessions.get(sessionId) !== undefined);
  }

  async flushLogs(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    await session.accessor.get(ISessionLogService).flush();
  }

  flushGlobalLogs(): Promise<void> {
    return this.log.flush();
  }
}

export class WSGateway implements IWSGateway {
  declare readonly _serviceBrand: undefined;
  private readonly connections = new Set<string>();

  constructor(
    @ISessionLifecycleService _sessions: ISessionLifecycleService,
    @IAgentRecordService _record: IAgentRecordService,
  ) {}

  connect(connectionId: string): void {
    this.connections.add(connectionId);
  }
  broadcast(_sessionId: string, _event: unknown): void {
  }
}

registerScopedService(LifecycleScope.App, IRestGateway, RestGateway, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.App, IWSGateway, WSGateway, InstantiationType.Delayed, 'gateway');
