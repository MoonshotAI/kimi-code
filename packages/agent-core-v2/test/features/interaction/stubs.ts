import { DisposableStore } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import { TestInstantiationService } from '#/_base/di/test';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type {
  AgentRuntimeDefinition,
  RuntimeOf,
} from '#/agent/runtime/agentRuntime';
import { AgentRuntimeSet } from '#/agent/runtime/agentRuntimeSet';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  AgentInteraction,
  type InteractionRuntime,
} from '#/features/interaction/interactionAgentRuntime';
import { IEventDispatcher } from '#/state/eventDispatcher';

export interface InteractionManagerStub {
  readonly manager: IAgentLifecycleService;
  runtimeOf(agentId: string): InteractionRuntime;
  dispatchedOf(agentId: string): readonly { type: string }[];
  readonly disposables: DisposableStore;
}

export function stubInteractionManagerFor(agentIds: readonly string[]): InteractionManagerStub {
  const disposables = new DisposableStore();
  const agents = new Map<
    string,
    { context: AgentContext; runtimes: AgentRuntimeSet; dispatched: { type: string }[] }
  >();
  for (const agentId of agentIds) {
    const ix = disposables.add(new TestInstantiationService());
    const scope = makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}`, generation: 1 });
    const context = scope.agentContext;
    const eventBus = disposables.add(new EventBusService());
    eventBus.activateAgent(context);
    const dispatched: { type: string }[] = [];
    ix.stub(IAgentScopeContext, scope);
    ix.stub(IEventBus, eventBus);
    ix.stub(IEventDispatcher, {
      _serviceBrand: undefined,
      dispatch: (event: { type: string }) => {
        dispatched.push({ type: event.type });
        return Promise.resolve();
      },
    } as unknown as IEventDispatcher);
    const runtimes = new AgentRuntimeSet(context, { get: (id) => ix.get(id) });
    runtimes.apply({
      definition: AgentInteraction,
      generation: 1,
      active: true,
    });
    agents.set(agentId, { context, runtimes, dispatched });
  }
  const manager = {
    _serviceBrand: undefined,
    onDidCreate: Event.None,
    get: (id: string) => agents.get(id)?.context,
    list: () => [...agents.values()].map((agent) => agent.context),
    resolve: <Definition extends AgentRuntimeDefinition<any, any>>(
      agent: AgentContext,
      definition: Definition,
    ): RuntimeOf<Definition> => {
      for (const candidate of agents.values()) {
        if (candidate.context === agent) return candidate.runtimes.resolve(definition);
      }
      throw new Error(`unknown agent ${agent.agentId}`);
    },
  } as unknown as IAgentLifecycleService;
  return {
    manager,
    runtimeOf: (agentId) => agents.get(agentId)!.runtimes.resolve(AgentInteraction),
    dispatchedOf: (agentId) => agents.get(agentId)!.dispatched,
    disposables,
  };
}

export function stubInteractionManager(agentId = 'main'): InteractionManagerStub {
  return stubInteractionManagerFor([agentId]);
}
