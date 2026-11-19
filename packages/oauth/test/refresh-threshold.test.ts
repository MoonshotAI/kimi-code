import { describe, expect, it } from 'vitest';

import { defaultRefreshThreshold } from '../src/oauth-manager';

describe('defaultRefreshThreshold — boundary cases', () => {
  it('returns expiresIn * 0.5 when ratio exceeds the 300s minimum (expiresIn=1800 → 900)', () => {
    expect(defaultRefreshThreshold(1800)).toBe(900);
  });

  it('clamps to the 300s minimum when expiresIn * 0.5 falls below (expiresIn=500 → 300)', () => {
    expect(defaultRefreshThreshold(500)).toBe(300);
  });

  it('falls back to the 300s minimum when expiresIn is 0 (expiresIn=0 → 300)', () => {
    expect(defaultRefreshThreshold(0)).toBe(300);
  });
});
