import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  type InteractionCancellation,
  type InteractionTags,
} from '#/human/interaction/interaction';
import { interactions } from '#/human/interaction/facade';
import type { InteractionEmitted } from '#/human/interaction/machine';
import type { IEventDispatcher } from '#/state/eventDispatcher';

import { InteractionRequestEvent, InteractionResolvedEvent } from './interactionOps';

export function attachInteractionAgent(
  agentId: string,
  sessionId: string,
  dispatcher: IEventDispatcher,
): void {
  interactions.attachAgent(agentId, sessionId, (emitted) => {
    dispatchInteractionEvent(agentId, emitted, dispatcher);
  });
}

export function detachInteractionAgent(agentId: string, sessionId: string): void {
  interactions.detachAgent(agentId, sessionId);
  for (const interaction of interactions.findAll({
    resolved: false,
    tags: { [INTERACTION_TAG_AGENT_ID]: agentId, [INTERACTION_TAG_SESSION_ID]: sessionId },
  })) {
    const response: InteractionCancellation = { cancelled: true, reason: 'agent_closed' };
    interactions.respond(interaction.id, response);
  }
}

export function cancelInteractionsForTurn(agentId: string, sessionId: string, turnId: number): void {
  for (const interaction of interactions.findAll({
    resolved: false,
    tags: {
      [INTERACTION_TAG_AGENT_ID]: agentId,
      [INTERACTION_TAG_SESSION_ID]: sessionId,
      turnId,
    },
  })) {
    const response: InteractionCancellation = { cancelled: true, reason: 'turn_ended' };
    interactions.respond(interaction.id, response);
  }
}

function dispatchInteractionEvent(
  agentId: string,
  emitted: InteractionEmitted,
  dispatcher: IEventDispatcher,
): void {
  if (emitted.type === 'interaction.requested') {
    const record = emitted.record;
    void dispatcher.dispatch(
      new InteractionRequestEvent({
        agentId,
        id: record.id,
        kind: record.kind,
        toolCallId:
          readStringTag(record.tags, INTERACTION_TAG_TOOL_CALL_ID) ??
          readPayloadToolCallId(record.payload),
        request: record.payload,
      }),
    );
    return;
  }
  void dispatcher.dispatch(
    new InteractionResolvedEvent({ agentId, id: emitted.id, response: emitted.response }),
  );
}

function readStringTag(tags: InteractionTags, key: string): string | undefined {
  const value = tags[key];
  return typeof value === 'string' ? value : undefined;
}

function readPayloadToolCallId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)['toolCallId'];
  return typeof value === 'string' ? value : undefined;
}
