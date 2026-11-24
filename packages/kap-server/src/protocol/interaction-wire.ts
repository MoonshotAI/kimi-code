import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  INTERACTION_TAG_TURN_ID,
  interactions,
  isInteractionCancellation,
  MAIN_AGENT_ID,
  type ApprovalRequest,
  type ApprovalResponse,
  type Interaction,
} from '@moonshot-ai/agent-core-v2';

import type { InteractionOutcome, PendingInteraction } from './interaction';
import { toWireQuestion } from './question-wire';

const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function approvalExpiresAt(interaction: Interaction): string {
  return new Date(interaction.createdAt + APPROVAL_EXPIRY_MS).toISOString();
}

export function interactionAgentId(interaction: Interaction): string {
  const tag = interaction.tags[INTERACTION_TAG_AGENT_ID];
  return typeof tag === 'string' ? tag : MAIN_AGENT_ID;
}

export function interactionToolCallId(interaction: Interaction): string | undefined {
  const tag = interaction.tags[INTERACTION_TAG_TOOL_CALL_ID];
  if (typeof tag === 'string') return tag;
  const fromPayload = (interaction.payload as { toolCallId?: unknown } | null | undefined)
    ?.toolCallId;
  return typeof fromPayload === 'string' ? fromPayload : undefined;
}

export function toPendingInteraction(
  interaction: Interaction,
  sessionId: string,
): PendingInteraction | undefined {
  const kind = interaction.kind;
  if (kind !== 'approval' && kind !== 'question') return undefined;
  const base = {
    interaction_id: interaction.id,
    session_id: sessionId,
    agent_id: interactionAgentId(interaction),
    created_at: new Date(interaction.createdAt).toISOString(),
    tool_call_id: interactionToolCallId(interaction),
  };
  if (kind === 'approval') {
    const request = interaction.payload as ApprovalRequest;
    return {
      ...base,
      kind,
      request: {
        tool_name: request.toolName,
        action: request.action,
        tool_input_display: request.display,
        expires_at: approvalExpiresAt(interaction),
      },
    };
  }
  return {
    ...base,
    kind,
    request: { questions: toWireQuestion(interaction, sessionId).questions },
  };
}

export function listPendingInteractions(sessionId: string): PendingInteraction[] {
  const raw = interactions.findAll({
    resolved: false,
    tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
  });
  const items: PendingInteraction[] = [];
  for (const interaction of raw) {
    const wire = toPendingInteraction(interaction, sessionId);
    if (wire !== undefined) items.push(wire);
  }
  return items;
}

export function toWireApproval(interaction: Interaction, sessionId: string): {
  approval_id: string;
  session_id: string;
  agent_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display: unknown;
  approval_detail?: ApprovalRequest['approvalDetail'];
  created_at: string;
  expires_at: string;
} {
  const p = interaction.payload as ApprovalRequest;
  const turnId = interaction.tags[INTERACTION_TAG_TURN_ID];
  return {
    approval_id: interaction.id,
    session_id: sessionId,
    agent_id: interactionAgentId(interaction),
    turn_id: typeof turnId === 'number' ? turnId : undefined,
    tool_call_id: p.toolCallId ?? interaction.id,
    tool_name: p.toolName,
    action: p.action,
    tool_input_display: p.display,
    approval_detail: p.approvalDetail,
    created_at: new Date(interaction.createdAt).toISOString(),
    expires_at: approvalExpiresAt(interaction),
  };
}

export function interactionOutcome(kind: 'approval' | 'question', response: unknown): InteractionOutcome {
  if (isInteractionCancellation(response)) return 'cancelled';
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  const decision = (response as Partial<ApprovalResponse> | null | undefined)?.decision;
  return decision === 'approved' || decision === 'rejected' ? decision : 'cancelled';
}
