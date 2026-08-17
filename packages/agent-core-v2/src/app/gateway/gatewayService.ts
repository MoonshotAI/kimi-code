import { LifecycleScope } from '#/app/scopes';

import {
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { Error2, ErrorCodes } from '#/errors';
import { ILogService } from '#/_base/log/log';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLoopService } from '#/agent/loop/loop';

import { IRestGateway, IWSGateway } from './gateway';

export class RestGateway implements IRestGateway {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionManager private readonly sessions: ISessionManager,
    @ILogService private readonly log: ILogService,
  ) { }

  private agent(sessionId: string, agentId: string): IAgentScopeHandle {
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
