import { describe, expect, it } from 'vitest';

import { ToolDedupService } from '#/tooldedup/tooldedupService';

describe('ToolDedupService', () => {
  it('detects same-step duplicates', () => {
    const d = new ToolDedupService(undefined as never, undefined as never);
    expect(d.checkSameStep('c1', { a: 1 })).toBe(false);
    expect(d.checkSameStep('c1', { a: 1 })).toBe(true);
    expect(d.checkSameStep('c1', { a: 2 })).toBe(false);
    d.dispose();
  });

  it('tracks cross-step streak via finalize', () => {
    const d = new ToolDedupService(undefined as never, undefined as never);
    d.finalize('same');
    d.finalize('same');
    d.finalize('same');
    expect(d.currentStreak).toBe(3);
    d.finalize('other');
    expect(d.currentStreak).toBe(1);
    d.dispose();
  });
});
