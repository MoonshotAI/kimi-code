import { describe, expect, it } from 'vitest';

import {
  GOAL_EXIT_CODES,
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
} from '#/cli/goal-prompt';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    goalId: 'g1',
    objective: 'work',
    status: 'complete',
    turnsUsed: 2,
    tokensUsed: 120,
    wallClockMs: 0,
    budget: {} as never,
    ...overrides,
  };
}

describe('goalExitCode', () => {
  it('maps final statuses to distinct codes', () => {
    expect(goalExitCode('complete')).toBe(GOAL_EXIT_CODES.complete);
    expect(goalExitCode('blocked')).toBe(GOAL_EXIT_CODES.blocked);
    expect(goalExitCode('paused')).toBe(GOAL_EXIT_CODES.paused);
    expect(goalExitCode(undefined)).toBe(0);
    expect(goalExitCode('impossible')).toBe(0);
    expect(new Set(Object.values(GOAL_EXIT_CODES)).size).toBe(Object.values(GOAL_EXIT_CODES).length);
  });
});

describe('parseHeadlessGoalCreate', () => {
  it('parses a create command into objective + replace', () => {
    const result = parseHeadlessGoalCreate('/goal Ship feature X');
    expect(result).toEqual({ objective: 'Ship feature X', replace: false });
  });

  it('returns undefined for non-goal prompts and non-create subcommands', () => {
    expect(parseHeadlessGoalCreate('say hello')).toBeUndefined();
    expect(parseHeadlessGoalCreate('/goal status')).toBeUndefined();
    expect(parseHeadlessGoalCreate('/goal pause')).toBeUndefined();
  });

  it('rejects malformed goal create prompts instead of falling through', () => {
    expect(() => parseHeadlessGoalCreate(`/goal ${'x'.repeat(4001)}`)).toThrow(
      'Goal objective is too long',
    );
  });
});

describe('goal summary', () => {
  it('includes id, status, reason, and usage', () => {
    const summary = goalSummaryJson(
      snapshot({
        status: 'blocked',
        terminalReason: 'need creds',
      }) as never,
    );
    expect(summary).toMatchObject({
      type: 'goal.summary',
      goalId: 'g1',
      status: 'blocked',
      reason: 'need creds',
      turnsUsed: 2,
      tokensUsed: 120,
    });
  });

  it('renders a null goal', () => {
    expect(goalSummaryJson(null).status).toBeNull();
    expect(formatGoalSummaryText(null)).toContain('no goal');
  });
});
