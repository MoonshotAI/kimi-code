import { describe, expect, it } from 'vitest';
import { updateGoalVisibleOutput } from '../src/chat/tool-calls/goalToolOutput';

describe('updateGoalVisibleOutput', () => {
  it('drops the model instruction after the first blank line', () => {
    const lines = [
      'Goal completed successfully.',
      'Worked 10 turns over 1m17s, using 245 tokens.',
      '',
      'Write a concise final message for the user. Do not call more goal tools.',
    ];
    expect(updateGoalVisibleOutput(lines)).toEqual(lines.slice(0, 2));
  });

  it('keeps output without a blank line in full', () => {
    const lines = ['Goal status updated to active.'];
    expect(updateGoalVisibleOutput(lines)).toEqual(lines);
  });
});
