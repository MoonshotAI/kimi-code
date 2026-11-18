import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { parseGoalCommand } from '#/tui/commands/index';

export interface HeadlessGoalCreate {
  readonly objective: string;
  readonly replace: boolean;
}

export const GOAL_EXIT_CODES = {
  complete: 0,
  blocked: 3,
  paused: 6,
} as const;

export function goalExitCode(status: string | undefined): number {
  switch (status) {
    case 'blocked':
      return GOAL_EXIT_CODES.blocked;
    case 'paused':
      return GOAL_EXIT_CODES.paused;
    default:
      return GOAL_EXIT_CODES.complete;
  }
}

const GOAL_PREFIX = /^\/goal(\s|$)/;

export function parseHeadlessGoalCreate(prompt: string): HeadlessGoalCreate | undefined {
  const trimmed = prompt.trim();
  if (!GOAL_PREFIX.test(trimmed)) return undefined;
  const args = trimmed.replace(/^\/goal/, '').trim();
  const parsed = parseGoalCommand(args);
  if (parsed.kind === 'error') {
    throw new Error(parsed.message);
  }
  if (parsed.kind !== 'create') return undefined;
  return { objective: parsed.objective, replace: parsed.replace };
}

export interface GoalSummary {
  readonly type: 'goal.summary';
  readonly goalId: string | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly turnsUsed: number | null;
  readonly tokensUsed: number | null;
  readonly wallClockMs: number | null;
}

export function goalSummaryJson(goal: GoalSnapshot | null): GoalSummary {
  if (goal === null) {
    return {
      type: 'goal.summary',
      goalId: null,
      status: null,
      reason: null,
      turnsUsed: null,
      tokensUsed: null,
      wallClockMs: null,
    };
  }
  return {
    type: 'goal.summary',
    goalId: goal.goalId,
    status: goal.status,
    reason: goal.terminalReason ?? null,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
    wallClockMs: goal.wallClockMs,
  };
}

export function formatGoalSummaryText(goal: GoalSnapshot | null): string {
  if (goal === null) return 'Goal: no goal found.';
  const parts = [`Goal [${goal.status}]`];
  if (goal.terminalReason !== undefined) parts.push(goal.terminalReason);
  return `${parts.join(': ')} (turns: ${goal.turnsUsed}, tokens: ${goal.tokensUsed})`;
}
