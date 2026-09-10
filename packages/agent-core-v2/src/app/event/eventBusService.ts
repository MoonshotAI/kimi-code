import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';

import type { AgentDomainTrait, Event2, Event2Class } from './event2';
import { IEventBus, ISessionEventBus } from './eventBus';

export class EventBusService extends Service implements ISessionEventBus {
  declare readonly _serviceBrand: undefined;

  private readonly allEmitter = this._register(new Emitter<Event2<any>>('*'));
  private readonly perType = new Map<string, Emitter<Event2<any>>>();
  private readonly agents = new Map<string, AgentContext>();
  private readonly sources = new WeakMap<Event2<any>, AgentContext>();

  activateAgent(agent: AgentContext): void {
    this.agents.set(agent.agentId, agent);
  }

  deactivateAgent(agent: AgentContext): void {
    if (this.agents.get(agent.agentId) === agent) this.agents.delete(agent.agentId);
  }

  publish(event: Event2<any>, agent?: AgentContext): void {
    const cls = event.constructor as Event2Class;
    if (cls.agentDomain) {
      if (
        agent === undefined ||
        this.agents.get(agent.agentId) !== agent ||
        (event as Event2<any> & AgentDomainTrait).agentId !== agent.agentId
      ) {
        throw new Error(`Agent event '${event.type}' has no active lifecycle context`);
      }
    }
    if (agent !== undefined) this.sources.set(event, agent);
    this.allEmitter.fire(event);
    this.perType.get(event.type)?.fire(event);
  }

  sourceOf(event: Event2<any>): AgentContext | undefined {
    return this.sources.get(event);
  }

  onAgent<P extends AgentDomainTrait, E extends Event2<P>>(
    agent: AgentContext,
    cls: Event2Class<P, E>,
    handler: (event: E) => void,
  ): IDisposable;
  onAgent(
    agent: AgentContext,
    type: string,
    handler: (event: Event2<any> & AgentDomainTrait) => void,
  ): IDisposable;
  onAgent(
    agent: AgentContext,
    typeOrClass: string | Event2Class<any, any>,
    handler: (event: any) => void,
  ): IDisposable {
    if (this.agents.get(agent.agentId) !== agent) {
      throw new Error(
        `Agent ${agent.agentId}:${String(agent.generation)} is not the active lifecycle context`,
      );
    }
    return this.subscribe(typeOrClass as string, (event) => {
      if (
        this.agents.get(agent.agentId) === agent &&
        (event as Event2<any> & AgentDomainTrait).agentId === agent.agentId
      ) {
        handler(event);
      }
    });
  }

  listenerCounts(): { all: number; perType: Record<string, number> } {
    const perType: Record<string, number> = {};
    for (const [type, emitter] of this.perType) {
      perType[type] = emitter.listenerCount;
    }
    return { all: this.allEmitter.listenerCount, perType };
  }

  subscribe(handler: (event: Event2<any>) => void): IDisposable;
  subscribe<P, E extends Event2<P>>(
    cls: Event2Class<P, E>,
    handler: (event: E) => void,
  ): IDisposable;
  subscribe(type: string, handler: (event: Event2<any>) => void): IDisposable;
  subscribe(
    typeOrHandler: string | Event2Class<any, any> | ((event: Event2<any>) => void),
    handler?: (event: Event2<any>) => void,
  ): IDisposable {
    if (typeof typeOrHandler === 'function' && !('type' in typeOrHandler)) {
      return this.allEmitter.event(typeOrHandler as (event: Event2<any>) => void);
    }
    const type = typeof typeOrHandler === 'string' ? typeOrHandler : typeOrHandler.type;
    let emitter = this.perType.get(type);
    if (emitter === undefined) {
      emitter = this._register(new Emitter<Event2<any>>(type));
      this.perType.set(type, emitter);
    }
    return emitter.event(handler!);
  }
}

export class AgentEventBusView extends Service implements IEventBus {
  declare readonly _serviceBrand: undefined;
  private readonly agent: AgentContext;

  constructor(
    @ISessionEventBus private readonly bus: ISessionEventBus,
    @IAgentScopeContext scope: IAgentScopeContext,
  ) {
    super();
    this.agent = scope.agentContext;
  }

  activateAgent(agent: AgentContext): void {
    this.bus.activateAgent(agent);
  }

  deactivateAgent(agent: AgentContext): void {
    this.bus.deactivateAgent(agent);
  }

  publish(event: Event2<any>, agent: AgentContext = this.agent): void {
    if (agent !== this.agent) throw new Error('Agent event bus view received a foreign context');
    this.bus.publish(event, this.agent);
  }

  onAgent<P extends AgentDomainTrait, E extends Event2<P>>(
    agent: AgentContext,
    cls: Event2Class<P, E>,
    handler: (event: E) => void,
  ): IDisposable;
  onAgent(
    agent: AgentContext,
    type: string,
    handler: (event: Event2<any> & AgentDomainTrait) => void,
  ): IDisposable;
  onAgent(
    agent: AgentContext,
    typeOrClass: string | Event2Class<any, any>,
    handler: (event: Event2<any> & AgentDomainTrait) => void,
  ): IDisposable {
    if (agent !== this.agent) throw new Error('Agent event bus view received a foreign context');
    return this.bus.onAgent(agent, typeOrClass as string, handler);
  }

  subscribe(handler: (event: Event2<any>) => void): IDisposable;
  subscribe<P, E extends Event2<P>>(
    cls: Event2Class<P, E>,
    handler: (event: E) => void,
  ): IDisposable;
  subscribe(type: string, handler: (event: Event2<any>) => void): IDisposable;
  subscribe(
    typeOrHandler: string | Event2Class<any, any> | ((event: Event2<any>) => void),
    handler?: (event: Event2<any>) => void,
  ): IDisposable {
    if ((this.bus as unknown) === undefined) return { dispose: () => {} };
    const matches = (event: Event2<any>): boolean => {
      const cls = event.constructor as Event2Class;
      if (cls.agentDomain) {
        return (event as Event2<any> & AgentDomainTrait).agentId === this.agent.agentId;
      }
      return this.bus.sourceOf(event) === this.agent;
    };
    if (typeof typeOrHandler === 'function' && !('type' in typeOrHandler)) {
      return this.bus.subscribe((event) => {
        if (matches(event)) typeOrHandler(event);
      });
    }
    return this.bus.subscribe(typeOrHandler as string, (event) => {
      if (matches(event)) handler!(event);
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionEventBus,
  EventBusService,
  ScopeActivation.OnScopeCreated,
  'event',
);

registerScopedService(
  LifecycleScope.Agent,
  IEventBus,
  AgentEventBusView,
  ScopeActivation.OnDemand,
  'eventView',
);
