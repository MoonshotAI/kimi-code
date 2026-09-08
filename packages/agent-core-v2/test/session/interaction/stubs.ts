import { DisposableStore } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { Event } from '#/_base/event';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionInteractionService,
  SessionInteractionService,
} from '#/session/interaction/sessionInteractionService';
import { IEventDispatcher } from '#/state/eventDispatcher';

export interface SessionInteractionStub {
  readonly service: ISessionInteractionService;
  readonly manager: IAgentLifecycleService;
  readonly bus: EventBusService;
  readonly disposables: DisposableStore;
}

export function stubSessionInteraction(
  agentIds: readonly string[] = [MAIN_AGENT_ID],
): SessionInteractionStub {
  const disposables = new DisposableStore();
  const bus = disposables.add(new EventBusService());
  const dispatcher = { dispatch: () => Promise.resolve() } as unknown as IEventDispatcher;
  const handles = new Map<string, IAgentScopeHandle>();
  for (const agentId of agentIds) {
    handles.set(agentId, {
      id: agentId,
      accessor: {
        get: (token: unknown) => (token === IEventDispatcher ? dispatcher : undefined),
      },
    } as unknown as IAgentScopeHandle);
  }
  const manager = {
    _serviceBrand: undefined,
    onDidCreate: Event.None,
    onDidClose: Event.None,
    handleOf: (id: string) => handles.get(id),
    list: () => [],
  } as unknown as IAgentLifecycleService;
  const service = disposables.add(new SessionInteractionService(bus, manager));
  return { service, manager, bus, disposables };
}
