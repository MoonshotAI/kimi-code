import type { SessionSummary } from '@moonshot-ai/agent-core';
import type { Session as ProtocolSession } from '@moonshot-ai/protocol';

import type { JsonObject } from '../types';

/**
 * Map a KAP protocol `session` to the SDK `SessionSummary` shape the TUI expects.
 *
 * Known localization gap: KAP `session` has no `sessionDir`; only `metadata.cwd`.
 * We fall back to `cwd` for `sessionDir` so the field is populated. The
 * `goal-queue-store` write to `<sessionDir>/upcoming-goals.json` is resolved in
 * Phase 9 (localization).
 */
export function toSessionSummary(session: ProtocolSession): SessionSummary {
  const cwd = typeof session.metadata?.cwd === 'string' ? session.metadata.cwd : '';
  return {
    id: session.id,
    title: session.title,
    lastPrompt: session.last_prompt,
    workDir: cwd,
    sessionDir: cwd, // localization gap — see Phase 9
    createdAt: Date.parse(session.created_at),
    updatedAt: Date.parse(session.updated_at),
    archived: session.archived,
    metadata: session.metadata as JsonObject | undefined,
  };
}

export interface CreateSessionPayloadLike {
  readonly id?: string;
  readonly workDir: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: 'yolo' | 'manual' | 'auto';
  readonly metadata?: Record<string, unknown>;
}

/** Build `POST /sessions` body (`sessionCreateSchema`) from a CoreAPI create payload. */
export function toCreateSessionBody(payload: CreateSessionPayloadLike): Record<string, unknown> {
  const agentConfig: Record<string, unknown> = {};
  if (payload.model !== undefined) agentConfig['model'] = payload.model;
  if (payload.thinking !== undefined) agentConfig['thinking'] = payload.thinking;
  if (payload.permission !== undefined) agentConfig['permission_mode'] = payload.permission;
  return {
    metadata: { ...(payload.metadata ?? {}), cwd: payload.workDir },
    ...(Object.keys(agentConfig).length > 0 ? { agent_config: agentConfig } : {}),
  };
}

import type { ApprovalRequest, ApprovalResponse, QuestionRequest, QuestionResult } from '@moonshot-ai/agent-core';
import type {
  ApprovalRequest as KapApprovalRequest,
  ApprovalResponse as KapApprovalResponse,
  QuestionRequest as KapQuestionRequest,
  QuestionResponse as KapQuestionResponse,
} from '@moonshot-ai/protocol';

/** KAP approval request (snake_case, with approval_id) → SDK ApprovalRequest (camelCase). */
export function toApprovalRequest(request: KapApprovalRequest): ApprovalRequest {
  return {
    turnId: request.turn_id !== undefined ? request.turn_id : undefined,
    toolCallId: request.tool_call_id,
    toolName: request.tool_name,
    action: request.action,
    display: request.tool_input_display as ApprovalRequest['display'],
  };
}

/** SDK ApprovalResponse → KAP approval resolve body (snake_case). */
export function toKapApprovalResponse(response: ApprovalResponse): KapApprovalResponse {
  return {
    decision: response.decision,
    ...(response.scope !== undefined ? { scope: response.scope } : {}),
    ...(response.feedback !== undefined ? { feedback: response.feedback } : {}),
    ...(response.selectedLabel !== undefined ? { selected_label: response.selectedLabel } : {}),
  };
}

/** KAP question request → SDK QuestionRequest. Item/option ids are synthesized by the daemon. */
export function toQuestionRequest(request: KapQuestionRequest): QuestionRequest {
  return {
    turnId: request.turn_id !== undefined ? request.turn_id : undefined,
    toolCallId: request.tool_call_id,
    questions: request.questions.map((item) => ({
      question: item.question,
      header: item.header,
      body: item.body,
      options: item.options.map((option) => ({ label: option.label, description: option.description })),
      multiSelect: item.multi_select,
      otherLabel: item.other_label,
      otherDescription: item.other_description,
    })),
  };
}

/** SDK QuestionResult → KAP question resolve body. */
export function toKapQuestionResponse(result: QuestionResult): KapQuestionResponse {
  if (result === null) {
    return { answers: {} };
  }
  // QuestionResult is Record<string, string|true> | QuestionResponse; normalize to KAP answers.
  const answers: KapQuestionResponse['answers'] = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (key === 'method') continue;
    if (typeof value === 'string') {
      answers[key] = { kind: 'single', option_id: value };
    } else if (value === true) {
      answers[key] = { kind: 'skipped' };
    }
  }
  return { answers };
}

import type { ContextMessage } from '@moonshot-ai/agent-core';
import type { Message as ProtocolMessage, MessageContent } from '@moonshot-ai/protocol';

/** Map a KAP wire `Message` to the agent-core `ContextMessage` used in replay. */
export function toContextMessage(message: ProtocolMessage): ContextMessage {
  return {
    role: message.role,
    content: message.content.map(toContextContent),
    toolCalls: [],
  } as ContextMessage;
}

function toContextContent(part: MessageContent): unknown {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'thinking':
      return { type: 'think', think: part.thinking };
    case 'tool_use':
      return {
        type: 'tool_call',
        id: part.tool_call_id,
        name: part.tool_name,
        arguments: part.input === undefined ? null : JSON.stringify(part.input),
      };
    case 'tool_result':
      return { type: 'tool_result', toolCallId: part.tool_call_id, output: part.output, isError: part.is_error };
    case 'image':
    case 'video':
    case 'file':
      return part; // pass through; refine if ContextMessage uses a different media shape
  }
}
