import type { ToolBeforeHook } from '@moonshot-ai/agent-core';
import type { ToolBeforeDecision } from '@moonshot-ai/agent-core/agent-machine/tool';

import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  isInteractionCancellation,
  type Interactions,
} from '#/features/interaction/index';

import { GOAL_BUDGET_TOOLS_REJECTED_MESSAGE, GOAL_STALE_TOOL_RESULT } from './prompts';
import type { GoalToolResult } from './types';

export const GOAL_START_REVIEW_KIND = 'goal_start';

export interface GoalStartReviewPayload {
  readonly kind: typeof GOAL_START_REVIEW_KIND;
  readonly objective?: string;
  readonly completionCriterion?: string;
}

export interface GoalStartApprovalResponse {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly feedback?: string;
}

export function isGoalMutationTool(toolName: string): boolean {
  return toolName === 'CreateGoal' || toolName === 'UpdateGoal' || toolName === 'SetGoalBudget';
}

export function createGoalGuard(deps: {
  readonly turnTarget: () => string | undefined;
  readonly getGoal: () => GoalToolResult;
  readonly inBudgetGraceTurn: () => boolean;
  readonly interactions: Interactions;
  readonly sessionId: string;
  readonly agentId: string;
}): ToolBeforeHook {
  const { turnTarget, getGoal, inBudgetGraceTurn, interactions, sessionId, agentId } = deps;
  return async ({ toolCall }) => {
    if (isGoalMutationTool(toolCall.name)) {
      const target = turnTarget();
      if (target !== undefined && getGoal().goal?.goalId !== target) {
        return deniedWith(GOAL_STALE_TOOL_RESULT);
      }
    }
    if (inBudgetGraceTurn()) {
      return deniedWith(GOAL_BUDGET_TOOLS_REJECTED_MESSAGE);
    }
    if (toolCall.name !== 'CreateGoal') return undefined;
    const args = parseGoalStartArgs(toolCall.arguments);
    const response = await interactions.request<GoalStartReviewPayload, GoalStartApprovalResponse>({
      kind: 'approval',
      payload: {
        kind: GOAL_START_REVIEW_KIND,
        objective: args?.objective,
        completionCriterion: args?.completionCriterion,
      },
      tags: {
        [INTERACTION_TAG_SESSION_ID]: sessionId,
        [INTERACTION_TAG_AGENT_ID]: agentId,
        [INTERACTION_TAG_TOOL_CALL_ID]: toolCall.id,
      },
    });
    if (isInteractionCancellation(response) || response.decision === 'cancelled') {
      return deniedWith(`Tool "CreateGoal" was not run because the approval request was cancelled.`);
    }
    if (response.decision !== 'approved') {
      const suffix =
        response.feedback !== undefined && response.feedback.length > 0
          ? ` Reason: ${response.feedback}`
          : '';
      return deniedWith(
        `Tool "CreateGoal" was not run because the user rejected the approval request.${suffix}`,
      );
    }
    return undefined;
  };
}

function deniedWith(text: string): ToolBeforeDecision {
  return { type: 'denied', result: { content: [{ type: 'text', text }] } };
}

function parseGoalStartArgs(
  raw: string | null,
): { readonly objective?: string; readonly completionCriterion?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  return {
    objective: typeof record['objective'] === 'string' ? record['objective'] : undefined,
    completionCriterion:
      typeof record['completionCriterion'] === 'string' ? record['completionCriterion'] : undefined,
  };
}
