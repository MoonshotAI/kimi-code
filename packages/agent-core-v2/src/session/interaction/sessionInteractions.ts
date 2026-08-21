import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentManager, MAIN_AGENT_ID } from '#/session/agentManager/agentManager';

import { AgentInteraction, type InteractionRuntime } from './interactionAgentRuntime';
import {
  type Interaction,
  type InteractionKind,
  type InteractionOrigin,
  type InteractionPendingChangedEvent,
  type InteractionRequest,
  type InteractionResolution,
} from './interaction';

function runtimeFor(manager: IAgentManager, origin: InteractionOrigin | undefined): InteractionRuntime {
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
  manager: IAgentManager,
  req: InteractionRequest<TPayload>,
): Promise<TResponse> {
  return runtimeFor(manager, req.origin).request(req);
}

export function enqueueSessionInteraction<TPayload>(
  manager: IAgentManager,
  req: InteractionRequest<TPayload>,
): Interaction {
  return runtimeFor(manager, req.origin).enqueue(req);
}

export function respondSessionInteraction(
  manager: IAgentManager,
  id: string,
  response: unknown,
): void {
  for (const context of manager.list()) {
    if (manager.resolve(context, AgentInteraction).respond(id, response)) return;
  }
}

export function listSessionPendingInteractions(
  manager: IAgentManager,
  kind?: InteractionKind,
): readonly Interaction[] {
  return manager
    .list()
    .flatMap((context) => manager.resolve(context, AgentInteraction).listPending(kind));
}

export function isSessionInteractionRecentlyResolved(manager: IAgentManager, id: string): boolean {
  for (const context of manager.list()) {
    if (manager.resolve(context, AgentInteraction).isRecentlyResolved(id)) return true;
  }
  return false;
}

export function onSessionInteractionDidChangePending(
  manager: IAgentManager,
  listener: (event: InteractionPendingChangedEvent) => void,
): IDisposable {
  const store = new DisposableStore();
  const attach = (context: AgentContext): void => {
    store.add(manager.resolve(context, AgentInteraction).onDidChangePending(listener));
  };
  for (const context of manager.list()) attach(context);
  store.add(manager.onDidCreate((context) => attach(context)));
  return store;
}

export function onSessionInteractionDidResolve(
  manager: IAgentManager,
  listener: (event: InteractionResolution) => void,
): IDisposable {
  const store = new DisposableStore();
  const attach = (context: AgentContext): void => {
    store.add(manager.resolve(context, AgentInteraction).onDidResolve(listener));
  };
  for (const context of manager.list()) attach(context);
  store.add(manager.onDidCreate((context) => attach(context)));
  return store;
}
