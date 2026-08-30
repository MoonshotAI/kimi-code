import { createMachine, createActor, type AnyActorRef } from 'xstate';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { PromptRuntime } from '#/features/prompt/prompt';

export interface AgentActorContract {
  readonly agent: AgentContext;
  readonly prompt: PromptRuntime['enqueue'];
  close(): Promise<void>;
}

export interface SessionActorContract {
  readonly sessionId: string;
  createAgent(agent: AgentContext, prompt: PromptRuntime['enqueue']): AgentActorContract;
  close(): Promise<void>;
}

export interface AppActorContract {
  createSession(sessionId: string): SessionActorContract;
  close(): Promise<void>;
}

export interface IActorHostService {
  readonly _serviceBrand: undefined;
  readonly app: AppActorContract;
  createSession(sessionId: string): SessionActorContract;
  createAgent(
    sessionId: string,
    agent: AgentContext,
    prompt: PromptRuntime['enqueue'],
  ): AgentActorContract;
  closeAgent(sessionId: string, agentId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

export const IActorHostService: ServiceIdentifier<IActorHostService> =
  createDecorator<IActorHostService>('actorHostService');

type StateActor = AnyActorRef;

const lifecycleMachine = createMachine({
  id: 'lifecycle',
  initial: 'active',
  states: {
    active: { on: { CLOSE: 'closing' } },
    closing: { on: { CLOSED: 'closed' } },
    closed: {},
  },
});

class AgentActorHost implements AgentActorContract {
  private readonly actor: StateActor = createActor(lifecycleMachine);
  private closed = false;

  constructor(
    readonly agent: AgentContext,
    private readonly onClose: () => Promise<void>,
    readonly prompt: PromptRuntime['enqueue'],
  ) {
    this.actor.start();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.actor.send({ type: 'CLOSE' });
    await this.onClose();
    this.actor.send({ type: 'CLOSED' });
    this.actor.stop();
  }
}

class SessionActorHost implements SessionActorContract {
  private readonly actor: StateActor = createActor(lifecycleMachine);
  private readonly agents = new Map<string, AgentActorHost>();
  private closed = false;

  constructor(readonly sessionId: string, private readonly onClose: () => Promise<void>) {
    this.actor.start();
  }

  createAgent(agent: AgentContext, prompt: PromptRuntime['enqueue']): AgentActorContract {
    if (this.closed) throw new Error(`Session actor '${this.sessionId}' is closed`);
    const existing = this.agents.get(agent.agentId);
    if (existing !== undefined) return existing;
    const child = new AgentActorHost(agent, async () => undefined, prompt);
    this.agents.set(agent.agentId, child);
    return child;
  }

  async closeAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent === undefined) return;
    await agent.close();
    this.agents.delete(agentId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.actor.send({ type: 'CLOSE' });
    for (const agent of [...this.agents.values()].reverse()) await agent.close();
    this.agents.clear();
    await this.onClose();
    this.actor.send({ type: 'CLOSED' });
    this.actor.stop();
  }
}

class AppActorHost implements AppActorContract {
  private readonly actor: StateActor = createActor(lifecycleMachine);
  private readonly sessions = new Map<string, SessionActorHost>();
  private closed = false;

  constructor() {
    this.actor.start();
  }

  createSession(sessionId: string): SessionActorContract {
    if (this.closed) throw new Error('App actor is closed');
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const child = new SessionActorHost(sessionId, async () => undefined);
    this.sessions.set(sessionId, child);
    return child;
  }

  getSession(sessionId: string): SessionActorHost | undefined {
    return this.sessions.get(sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.actor.send({ type: 'CLOSE' });
    for (const session of [...this.sessions.values()].reverse()) await session.close();
    this.sessions.clear();
    this.actor.send({ type: 'CLOSED' });
    this.actor.stop();
  }
}

export class ActorHostService extends Disposable implements IActorHostService {
  declare readonly _serviceBrand: undefined;
  readonly app: AppActorContract = new AppActorHost();

  constructor() {
    super();
    this._register({ dispose: () => { void this.app.close(); } });
  }

  createSession(sessionId: string): SessionActorContract {
    return this.app.createSession(sessionId);
  }

  createAgent(sessionId: string, agent: AgentContext, prompt: PromptRuntime['enqueue']): AgentActorContract {
    return this.app.createSession(sessionId).createAgent(agent, prompt);
  }

  closeAgent(sessionId: string, agentId: string): Promise<void> {
    const session = (this.app as AppActorHost).getSession(sessionId);
    return session?.closeAgent(agentId) ?? Promise.resolve();
  }

  closeSession(sessionId: string): Promise<void> {
    const session = (this.app as AppActorHost).getSession(sessionId);
    return session?.close() ?? Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.App,
  IActorHostService,
  ActorHostService,
  ScopeActivation.OnScopeCreated,
  'actorHost',
);
