import { describe, expect, it } from 'vitest';

import { now, setNow } from '#/utils/now';

describe('utils now', () => {
  it('returns wall-clock time by default', () => {
    const before = Date.now();
    const value = now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });

  it('routes through the injected implementation and resets', () => {
    setNow(() => 42);
    expect(now()).toBe(42);
    setNow();
    expect(now()).toBeGreaterThan(42);
  });
});
