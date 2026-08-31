import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { AgentInteraction, type InteractionRuntime } from './interactionAgentRuntime';
import {
  type Interaction,
  type InteractionKind,
  type InteractionOrigin,
  type InteractionPendingChangedEvent,
  type InteractionRequest,
  type InteractionResolution,
} from './interaction';

function runtimeFor(manager: IAgentLifecycleService, origin: InteractionOrigin | undefined): InteractionRuntime {
  const agentId = origin?.agentId ?? MAIN_AGENT_ID;
  const context = manager.get(agentId);
  if (context === undefined) {
    throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, {
      details: { agentId },
    });
  }
  return manager.resolve(context, AgentInteraction);
}

export function requestSessionInteraction<TPayload, TResponse>(
  manager: IAgentLifecycleService,
  req: InteractionRequest<TPayload>,
): Promise<TResponse> {
  assertAvailableId(manager, req.id);
  return runtimeFor(manager, req.origin).request(req);
}

export function enqueueSessionInteraction<TPayload>(
  manager: IAgentLifecycleService,
  req: InteractionRequest<TPayload>,
): Interaction {
  assertAvailableId(manager, req.id);
  return runtimeFor(manager, req.origin).enqueue(req);
}

function assertAvailableId(manager: IAgentLifecycleService, id: string | undefined): void {
  if (id === undefined) return;
  if (listSessionPendingInteractions(manager).some((interaction) => interaction.id === id)) {
    throw new Error(`Interaction "${id}" is already pending`);
  }
}

export function respondSessionInteraction(
  manager: IAgentLifecycleService,
  id: string,
  response: unknown,
): void {
  for (const context of manager.list()) {
    if (manager.resolve(context, AgentInteraction).respond(id, response)) return;
  }
}

export function listSessionPendingInteractions(
  manager: IAgentLifecycleService,
  kind?: InteractionKind,
): readonly Interaction[] {
  return manager
    .list()
    .flatMap((context) => manager.resolve(context, AgentInteraction).listPending(kind));
}

export function isSessionInteractionRecentlyResolved(manager: IAgentLifecycleService, id: string): boolean {
  for (const context of manager.list()) {
    if (manager.resolve(context, AgentInteraction).isRecentlyResolved(id)) return true;
  }
  return false;
}

export function onSessionInteractionDidChangePending(
  manager: IAgentLifecycleService,
  listener: (event: InteractionPendingChangedEvent) => void,
): IDisposable {
  const store = new DisposableStore();
  const subscriptions = new Map<string, IDisposable>();
  const attach = (context: AgentContext): void => {
    const subscription = manager.resolve(context, AgentInteraction).onDidChangePending(listener);
    subscriptions.set(context.agentId, subscription);
    store.add(subscription);
  };
  const detach = (context: AgentContext): void => {
    subscriptions.get(context.agentId)?.dispose();
    subscriptions.delete(context.agentId);
  };
  for (const context of manager.list()) attach(context);
  store.add(manager.onDidCreate((context) => attach(context)));
  store.add(manager.onDidClose(detach));
  return store;
}

export function onSessionInteractionDidResolve(
  manager: IAgentLifecycleService,
  listener: (event: InteractionResolution) => void,
): IDisposable {
  const store = new DisposableStore();
  const subscriptions = new Map<string, IDisposable>();
  const attach = (context: AgentContext): void => {
    const subscription = manager.resolve(context, AgentInteraction).onDidResolve(listener);
    subscriptions.set(context.agentId, subscription);
    store.add(subscription);
  };
  const detach = (context: AgentContext): void => {
    subscriptions.get(context.agentId)?.dispose();
    subscriptions.delete(context.agentId);
  };
  for (const context of manager.list()) attach(context);
  store.add(manager.onDidCreate((context) => attach(context)));
  store.add(manager.onDidClose(detach));
  return store;
}
