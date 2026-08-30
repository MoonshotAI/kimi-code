import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { Error2, ErrorCodes } from '#/errors';
import { ILogService } from '#/_base/log/log';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { AgentPrompt } from '#/features/prompt/promptAgentRuntime';
import { getLoopControl } from '#/features/loop/internal/access';

import { IRestGateway, IWSGateway } from './gateway';

export class RestGateway implements IRestGateway {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionManager private readonly sessions: ISessionManager,
    @ILogService private readonly log: ILogService,
  ) { }

  private agent(sessionId: string, agentId: string): AgentContext {
    const session = this.liveSession(sessionId);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `unknown session '${sessionId}'`, {
        details: { sessionId },
      });
    }
    const agents = session.accessor.get(IAgentLifecycleService);
    const agent = agents.get(agentId);
    if (agent === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `unknown agent '${agentId}'`, {
        details: { agentId, sessionId },
      });
    }
    return agent;
  }

  private liveSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  async prompt(
    sessionId: string,
    agentId: string,
    input: string,
  ): Promise<{ readonly turn_id: number } | undefined> {
    const agent = this.agent(sessionId, agentId);
    const session = this.liveSession(sessionId)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const domain = lifecycle.domain?.(agentId);
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: input }],
      toolCalls: [],
      origin: { kind: 'user' as const },
    };
    const handle = await (domain === undefined
      ? lifecycle.resolve(agent, AgentPrompt).enqueue({ message })
      : domain.prompt({ message }));
    const turn = await handle.launched;
    return turn === undefined ? undefined : { turn_id: turn.id };
  }
  async steer(
    sessionId: string,
    agentId: string,
    content: string,
  ): Promise<{ readonly turn_id: number } | undefined> {
    const agent = this.agent(sessionId, agentId);
    const service = this.liveSession(sessionId)!.accessor.get(IAgentLifecycleService).resolve(agent, AgentPrompt);
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
    const session = this.liveSession(sessionId);
    if (session === undefined) return Promise.resolve();
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const domain = lifecycle.domain?.(agentId);
    if (domain !== undefined) return domain.cancel(reason);
    getLoopControl(this.agent(sessionId, agentId)).cancel(undefined, reason);
    return Promise.resolve();
  }
  getStatus(sessionId: string): Promise<unknown> {
    return Promise.resolve(this.liveSession(sessionId) !== undefined);
  }

  async flushLogs(sessionId: string): Promise<void> {
    const session = this.liveSession(sessionId);
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

  connect(connectionId: string): void {
    this.connections.add(connectionId);
  }
  broadcast(_sessionId: string, _event: unknown): void {
  }
}

registerScopedService(LifecycleScope.App, IRestGateway, RestGateway, ScopeActivation.OnScopeCreated, 'gateway');
registerScopedService(LifecycleScope.App, IWSGateway, WSGateway, ScopeActivation.OnScopeCreated, 'gateway');
