import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_TURN_ID,
  MAIN_AGENT_ID,
  type ApprovalRequest,
  type Interaction,
} from '@moonshot-ai/agent-core-v2';

const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function approvalExpiresAt(interaction: Interaction): string {
  return new Date(interaction.createdAt + APPROVAL_EXPIRY_MS).toISOString();
}

export function interactionAgentId(interaction: Interaction): string {
  const tag = interaction.tags[INTERACTION_TAG_AGENT_ID];
  return typeof tag === 'string' ? tag : MAIN_AGENT_ID;
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
    created_at: new Date(interaction.createdAt).toISOString(),
    expires_at: approvalExpiresAt(interaction),
  };
}
