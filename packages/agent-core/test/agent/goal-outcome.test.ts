import { describe, expect, it } from 'vitest';

import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
} from '../../src/tools/builtin/goal/outcome-prompts';
import type { GoalSnapshot } from '../../src/agent/goal';

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

describe('goal outcome prompts', () => {
  it('uses stronger ASCII-only wording in the completion prompt sent to the model', () => {
    const text = buildGoalCompletionSummaryPrompt(snapshot());
    expect(text).toContain('Goal completed successfully: all tests pass.');
    expect(text).toContain('Write a concise final message for the user');
    expect(text).not.toContain('✓');
    expect(text).not.toContain('—');
  });

  it('uses stronger wording in the blocked prompt sent to the model', () => {
    const text = buildGoalBlockedReasonPrompt(snapshot({ status: 'blocked' }));
    expect(text).toContain('Goal blocked.');
    expect(text).toContain('State that the goal is blocked');
    expect(text).toContain('concrete blocker');
  });
});
