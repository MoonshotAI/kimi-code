import { describe, expect, it } from 'vitest';

import { WORKING_TIPS, currentWorkingTip } from '#/tui/components/chrome/working-tips';

describe('currentWorkingTip', () => {
  it('returns a tip from WORKING_TIPS', () => {
    const now = Date.now();
    const tip = currentWorkingTip(now);
    expect(tip).toBeDefined();
    expect(WORKING_TIPS.some((t) => t.text === tip!.text)).toBe(true);
  });

  it('returns the same tip for the same timestamp', () => {
    const now = 1_000_000;
    const first = currentWorkingTip(now);
    const second = currentWorkingTip(now);
    expect(first).toBe(second);
  });
});
