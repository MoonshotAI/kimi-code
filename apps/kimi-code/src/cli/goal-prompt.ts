import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { parseGoalCommand } from '#/tui/commands/index';

/**
 * Headless goal-mode support for the `kimi -p "/goal <objective>"` prompt path.
 *
 * The goal driver keeps the prompt's turn-run alive across continuation turns
 * until the goal reaches a terminal state, so the existing prompt-turn waiter
 * already blocks until then. This module adds the create-on-entry parsing, a
 * machine-readable summary, and the terminal-status → exit-code mapping.
 */

export interface HeadlessGoalCreate {
  readonly objective: string;
  readonly replace: boolean;
}

/**
 * Exit codes by final goal status. The lifecycle has only one success outcome
 * (`complete` → 0) and two resumable stopped states: `blocked` (the system
 * stopped pursuing — the model's UpdateGoal, a budget, or an error) and `paused`
 * (a turn abort / SIGINT). Both are non-zero — the goal did not complete. An absent goal
 * (should not happen on the create path) maps to success.
 */
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

/**
 * Parses a headless prompt into a goal-create request, or `undefined` when the
 * prompt is not a `/goal` create command (so the caller runs it as a normal
 * prompt). Non-create goal subcommands are not supported headless and fall
 * through to normal prompt handling.
 */
export function parseHeadlessGoalCreate(prompt: string): HeadlessGoalCreate | undefined {
  const trimmed = prompt.trim();
  if (!GOAL_PREFIX.test(trimmed)) return undefined;
  const args = trimmed.replace(/^\/goal/, '').trim();
  const parsed = parseGoalCommand(args);
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
