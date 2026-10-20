import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';
import type { ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { ToolPermittingDecision } from '@moonshot-ai/agent-core/loop/index';

import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  isInteractionCancellation,
  type Interactions,
} from '#/features/interaction/index';

import { permissionRuleMatcher } from './language/tool-matchers';
import type { PermissionApprovalResultRecord } from './state/projection';
import type { ApprovalResponse, PermissionApprovalDisplay } from './types';

export interface PermissionApprovalDeps {
  readonly interactions: Interactions;
  readonly fire: (event: RuntimeEvent) => void;
  readonly recordApprovalResult: (record: PermissionApprovalResultRecord) => Promise<void>;
  readonly sessionId: string;
  readonly agentId: string;
  readonly isMain: boolean;
}

export async function requestToolApproval(
  deps: PermissionApprovalDeps,
  input: {
    readonly toolCall: ToolCall;
    readonly args: Record<string, unknown> | undefined;
  },
): Promise<ToolPermittingDecision | undefined> {
  const name = input.toolCall.name;
  const action = `Approve ${name}`;
  const display: PermissionApprovalDisplay = {
    kind: 'generic',
    summary: action,
    detail: input.args,
  };
  const approvalRequest = {
    id: `approval_${crypto.randomUUID()}`,
    sessionId: deps.sessionId,
    agentId: deps.agentId,
    toolCallId: input.toolCall.id,
    toolName: name,
    action,
    display,
  };
  const approvalContext = { ...approvalRequest, toolInput: input.args };
  deps.fire({ type: 'permission.approval.requested', ...approvalContext });

  let response: ApprovalResponse;
  try {
    const raw = await deps.interactions.request<typeof approvalRequest, unknown>({
      id: approvalRequest.id,
      kind: 'approval',
      payload: approvalRequest,
      tags: {
        [INTERACTION_TAG_AGENT_ID]: deps.agentId,
        [INTERACTION_TAG_SESSION_ID]: deps.sessionId,
        [INTERACTION_TAG_TOOL_CALL_ID]: input.toolCall.id,
      },
    });
    response = isInteractionCancellation(raw) ? { decision: 'cancelled' } : (raw as ApprovalResponse);
  } catch (error) {
    deps.fire({
      type: 'permission.approval.resolved',
      ...approvalContext,
      decision: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const sessionApprovalRule =
    response.decision === 'approved' && response.scope === 'session' && input.args !== undefined
      ? permissionRuleMatcher(name)?.approvalRule?.(input.args)
      : undefined;
  deps.fire({ type: 'permission.approval.resolved', ...approvalContext, ...response });
  await deps.recordApprovalResult({
    toolCallId: input.toolCall.id,
    toolName: name,
    action,
    sessionApprovalRule,
    result: response,
  });

  if (response.decision === 'approved') return undefined;
  return deniedWith(formatApprovalRejectionMessage(name, response, deps.isMain));
}

export function formatApprovalRejectionMessage(
  toolName: string,
  result: Pick<ApprovalResponse, 'decision' | 'feedback'>,
  isMain: boolean,
): string {
  const suffix =
    result.feedback !== undefined && result.feedback.length > 0
      ? ` Reason: ${result.feedback}`
      : '';
  const prefix =
    result.decision === 'cancelled'
      ? `Tool "${toolName}" was not run because the approval request was cancelled.`
      : `Tool "${toolName}" was not run because the user rejected the approval request.`;
  if (usesWorkerRejectionGuidance(isMain)) {
    return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
  }
  return `${prefix}${suffix}`;
}

export function formatDenyMessage(message: string, isMain: boolean): string {
  if (usesWorkerRejectionGuidance(isMain)) {
    return `${message} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
  }
  return message;
}

function usesWorkerRejectionGuidance(isMain: boolean): boolean {
  return !isMain;
}

function deniedWith(text: string): ToolPermittingDecision {
  return {
    blocked: { reason: 'denied', message: text },
    result: { content: [{ type: 'text', text }] },
  };
}
