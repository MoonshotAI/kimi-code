import { createMachine, createActor, type AnyActorRef } from 'xstate';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { PromptRuntime } from '#/features/prompt/prompt';
import type { AgentRuntimeHost } from '#/lifecycle/internal/agentRuntimeHost';

export type AgentLifecycleState = 'active' | 'closing' | 'closed';

export interface AgentDomainContract {
  readonly agentId: string;
  prompt(input: Parameters<PromptRuntime['enqueue']>[0]): ReturnType<PromptRuntime['enqueue']>;
  cancel(reason?: string): Promise<void>;
  state(): AgentLifecycleState;
  close(): Promise<void>;
}

export interface AgentActorContract extends AgentDomainContract {
  readonly agent: AgentContext;
}

type AgentCreation = Promise<{ agent: AgentContext; host: AgentRuntimeHost }>;

export interface SessionActorContract {
  readonly sessionId: string;
  createAgent(agentId: string, operation: () => AgentCreation): Promise<AgentActorContract>;
  getAgent(agentId: string): AgentDomainContract | undefined;
  closeAgent(agentId: string): Promise<void>;
  close(): Promise<void>;
}

export interface AppActorContract {
  createSession(sessionId: string): SessionActorContract;
  getSession(sessionId: string): SessionActorContract | undefined;
  close(): Promise<void>;
}

export interface IActorHostService {
  readonly _serviceBrand: undefined;
  readonly app: AppActorContract;
  createSession(sessionId: string): SessionActorContract;
  createAgent(sessionId: string, agentId: string, operation: () => AgentCreation): Promise<AgentActorContract>;
  getAgent(sessionId: string, agentId: string): AgentDomainContract | undefined;
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

class AgentActor {
  private readonly ref: StateActor = createActor(lifecycleMachine);

  constructor() {
    this.ref.start();
  }

  state(): AgentLifecycleState {
    return this.ref.getSnapshot().value as AgentLifecycleState;
  }

  closing(): void {
    this.ref.send({ type: 'CLOSE' });
  }

  closed(): void {
    this.ref.send({ type: 'CLOSED' });
    this.ref.stop();
  }
}

class AgentDomain implements AgentActorContract {
  private readonly actor = new AgentActor();
  private closing: Promise<void> | undefined;

  constructor(
    readonly agent: AgentContext,
    private readonly host: AgentRuntimeHost,
  ) {}

  get agentId(): string {
    return this.agent.agentId;
  }

  prompt(input: Parameters<PromptRuntime['enqueue']>[0]): ReturnType<PromptRuntime['enqueue']> {
    this.assertActive('prompt');
    return this.host.prompt(input);
  }

  cancel(reason?: string): Promise<void> {
    this.assertActive('cancel');
    return this.host.cancel(reason);
  }

  state(): AgentLifecycleState {
    return this.actor.state();
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.actor.closing();
    this.closing = this.host.close().finally(() => this.actor.closed());
    return this.closing;
  }

  private assertActive(operation: string): void {
    if (this.state() !== 'active') {
      throw new Error(`Agent '${this.agentId}' is ${this.state()} and cannot ${operation}`);
    }
  }
}

class SessionActorHost implements SessionActorContract {
  private readonly actor: StateActor = createActor(lifecycleMachine);
  private readonly agents = new Map<string, AgentDomain>();
  private readonly creating = new Map<string, Promise<AgentActorContract>>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(readonly sessionId: string, private readonly onClose: () => Promise<void>) {
    this.actor.start();
  }

  async createAgent(agentId: string, operation: () => AgentCreation): Promise<AgentActorContract> {
    if (this.closed) throw new Error(`Session actor '${this.sessionId}' is closed`);
    const existing = this.agents.get(agentId);
    if (existing !== undefined) return existing;
    const inflight = this.creating.get(agentId);
    if (inflight !== undefined) return inflight;
    const promise = operation().then(({ agent, host }) => {
      if (this.closed) {
        return host.close().then(() => {
          throw new Error(`Session actor '${this.sessionId}' is closed`);
        });
      }
      const domain = new AgentDomain(agent, host);
      this.agents.set(agentId, domain);
      return domain;
    });
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
  }

  getAgent(agentId: string): AgentDomainContract | undefined {
    return this.agents.get(agentId);
  }

  async closeAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent === undefined) return;
    await agent.close();
    this.agents.delete(agentId);
  }

  async close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      this.actor.send({ type: 'CLOSE' });
      await Promise.allSettled(this.creating.values());
      for (const agent of [...this.agents.values()].reverse()) await agent.close();
      this.agents.clear();
      await this.onClose();
      this.actor.send({ type: 'CLOSED' });
      this.actor.stop();
    })();
    return this.closing;
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
    let child: SessionActorHost;
    child = new SessionActorHost(sessionId, async () => {
      if (this.sessions.get(sessionId) === child) this.sessions.delete(sessionId);
    });
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

  createAgent(
    sessionId: string,
    agentId: string,
    operation: () => AgentCreation,
  ): Promise<AgentActorContract> {
    return this.app.createSession(sessionId).createAgent(agentId, operation);
  }

  getAgent(sessionId: string, agentId: string): AgentDomainContract | undefined {
    return this.app.getSession(sessionId)?.getAgent(agentId);
  }

  closeAgent(sessionId: string, agentId: string): Promise<void> {
    return this.app.getSession(sessionId)?.closeAgent(agentId) ?? Promise.resolve();
  }

  closeSession(sessionId: string): Promise<void> {
    return this.app.getSession(sessionId)?.close() ?? Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.App,
  IActorHostService,
  ActorHostService,
  ScopeActivation.OnScopeCreated,
  'actorHost',
);
