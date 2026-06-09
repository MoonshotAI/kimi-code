import { describe, expect, it } from 'vitest';

import { buildGoalCompletionMessage } from '#/tui/utils/goal-completion';
import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    objective: 'work',
    status: 'complete',
    turnsUsed: 3,
    tokensUsed: 12_500,
    wallClockMs: 260_000,
    terminalReason: 'all tests pass',
    ...overrides,
  } as GoalSnapshot;
}

describe('buildGoalCompletionMessage', () => {
  it('includes the reason, exact turns, tokens, and time', () => {
    const text = buildGoalCompletionMessage(snapshot());
    expect(text).toContain('Goal complete — all tests pass.');
    expect(text).toContain('3 turns');
    expect(text).toContain('12.5k tokens');
    expect(text).toContain('4m20s');
  });

  it('omits the dash when there is no reason and singularizes one turn', () => {
    const text = buildGoalCompletionMessage(
      snapshot({ terminalReason: undefined, turnsUsed: 1, tokensUsed: 800, wallClockMs: 5000 }),
    );
    expect(text).toContain('Goal complete.');
    expect(text).not.toContain('—');
    expect(text).toContain('1 turn ');
    expect(text).toContain('800 tokens');
    expect(text).toContain('5s');
  });
});
