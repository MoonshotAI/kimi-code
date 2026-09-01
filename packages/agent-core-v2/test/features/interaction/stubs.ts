import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { Event } from '#/_base/event';
import { TestInstantiationService } from '#/_base/di/test';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { LifecycleScope } from '#/app/scopes';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import {
  AgentInteractionService,
  IAgentInteractionService,
} from '#/features/interaction/interactionService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

export interface InteractionManagerStub {
  readonly manager: IAgentLifecycleService;
  serviceOf(agentId: string): IAgentInteractionService;
  readonly disposables: DisposableStore;
}

export function stubInteractionManagerFor(agentIds: readonly string[]): InteractionManagerStub {
  const disposables = new DisposableStore();
  const agents = new Map<
    string,
    { context: AgentContext; handle: IAgentScopeHandle; service: IAgentInteractionService }
  >();
  for (const agentId of agentIds) {
    const ix = disposables.add(new TestInstantiationService());
    const scope = makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}`, generation: 1 });
    const context = scope.agentContext;
    const eventBus = disposables.add(new EventBusService());
    eventBus.activateAgent(context);
    registerTestAgentWire(ix, testWireScope('interaction-stub', agentId));
    ix.stub(IAgentScopeContext, scope);
    ix.stub(IEventBus, eventBus);
    registerTestEventDispatcher(ix);
    ix.set(IAgentInteractionService, new SyncDescriptor(AgentInteractionService));
    const service = ix.get(IAgentInteractionService);
    const handle = {
      id: agentId,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (token: unknown) => (token === IAgentInteractionService ? service : undefined),
      },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;
    agents.set(agentId, { context, handle, service });
  }
  const manager = {
    _serviceBrand: undefined,
    onDidCreate: Event.None,
    onDidClose: Event.None,
    get: (id: string) => agents.get(id)?.context,
    list: () => [...agents.values()].map((agent) => agent.context),
    handleOf: (id: string) => agents.get(id)?.handle,
  } as unknown as IAgentLifecycleService;
  return {
    manager,
    serviceOf: (agentId) => agents.get(agentId)!.service,
    disposables,
  };
}

export function stubInteractionManager(agentId = 'main'): InteractionManagerStub {
  return stubInteractionManagerFor([agentId]);
}
