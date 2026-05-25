import { describe, expect, it } from 'vitest';

import { outputTokensPerSecond } from '#/tui/utils/token-throughput';

describe('outputTokensPerSecond', () => {
  it('computes output token throughput from elapsed time', () => {
    expect(
      outputTokensPerSecond(
        {
          inputOther: 100,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          output: 75,
        },
        1_000,
        4_000,
      ),
    ).toBe(25);
  });

  it('returns null for missing usage, zero output, or invalid duration', () => {
    expect(outputTokensPerSecond(undefined, 1_000, 4_000)).toBeNull();
    expect(
      outputTokensPerSecond(
        {
          inputOther: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          output: 0,
        },
        1_000,
        4_000,
      ),
    ).toBeNull();
    expect(
      outputTokensPerSecond(
        {
          inputOther: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          output: 10,
        },
        4_000,
        1_000,
      ),
    ).toBeNull();
  });
});
