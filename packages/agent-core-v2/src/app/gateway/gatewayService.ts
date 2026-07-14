/**
 * `gateway` domain (L7) — `IRestGateway` / `IWSGateway` implementations.
 *
 * Owns the REST/WS entry points; resolves sessions through `sessionLifecycle`,
 * agents through `agentLifecycle`, drives turns through `prompt` / `loop`,
 * and flushes logs through `log`. Bound at App scope.
 *
 * WS event fan-out (sequencing, journaling, replay, per-connection dispatch)
 * is a transport concern and lives in the edge package (`packages/kap-server`)
 * on top of `IEventService` + `IAgentRecordService` — not here.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ILogService } from '#/_base/log/log';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLoopService } from '#/agent/loop/loop';

import { IRestGateway, IWSGateway } from './gateway';

export class RestGateway implements IRestGateway {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionLifecycleService private readonly sessions: ISessionLifecycleService,
    @ILogService private readonly log: ILogService,
  ) { }

  private agent(sessionId: string, agentId: string): IAgentScopeHandle {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`unknown session '${sessionId}'`);
    const agents = session.accessor.get(IAgentLifecycleService);
    const agent = agents.get(agentId);
    if (agent === undefined) throw new Error(`unknown agent '${agentId}'`);
    return agent;
  }

  async prompt(
    sessionId: string,
    agentId: string,
    input: string,
  ): Promise<{ readonly turn_id: number } | undefined> {
    const handle = await this.agent(sessionId, agentId).accessor.get(IAgentPromptService).enqueue({
      message: {
        role: 'user',
        content: [{ type: 'text', text: input }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const turn = await handle.launched;
    return turn === undefined ? undefined : { turn_id: turn.id };
  }
  async steer(
    sessionId: string,
    agentId: string,
    content: string,
  ): Promise<{ readonly turn_id: number } | undefined> {
    const service = this.agent(sessionId, agentId).accessor.get(IAgentPromptService);
    const queued = await service.enqueue({ message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
      toolCalls: [],
      origin: { kind: 'user' },
    } });
    const [steered] = await service.steer([queued.id]);
    const turn = await steered?.launched;
    return turn === undefined ? undefined : { turn_id: turn.id };
  }
  cancel(sessionId: string, agentId: string, reason?: string): Promise<void> {
    this.agent(sessionId, agentId).accessor.get(IAgentLoopService).cancel(undefined, reason);
    return Promise.resolve();
  }
  getStatus(sessionId: string): Promise<unknown> {
    return Promise.resolve(this.sessions.get(sessionId) !== undefined);
  }

  async flushLogs(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    await session.accessor.get(ILogService).flush();
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
  ) { }

  connect(connectionId: string): void {
    this.connections.add(connectionId);
  }
  broadcast(_sessionId: string, _event: unknown): void {
  }
}

registerScopedService(LifecycleScope.App, IRestGateway, RestGateway, InstantiationType.Eager, 'gateway');
registerScopedService(LifecycleScope.App, IWSGateway, WSGateway, InstantiationType.Eager, 'gateway');
