import { describe, expect, it, vi } from 'vitest';

import { buildGoalCompletionMessage } from '#/tui/utils/goal-completion';
import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

vi.mock('#/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>): string => {
    const translations: Record<string, string> = {
      'tui.messages.goalComplete': 'Goal complete{{reason}}.',
      'tui.messages.goalCompleteTurns': '{{count}} turn{{plural}}',
      'tui.messages.goalCompleteSummary':
        '{{turns}} · {{elapsed}} · {{tokens}} tokens',
      'tui.messages.goalFormat.elapsedSeconds': '{{count}}s',
      'tui.messages.goalFormat.elapsedMinutes': '{{minutes}}m {{seconds}}s',
    };
    const msg = translations[key] ?? key;
    if (!params) return msg;
    let result = msg;
    for (const [k, v] of Object.entries(params)) {
      result = result.replaceAll(`{{${k}}}`, String(v));
    }
    return result;
  },
  setLocale: vi.fn(),
  getLocale: () => 'en',
}));

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
    expect(text).toContain('12.2k tokens');
    expect(text).toContain('4m 20s');
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
