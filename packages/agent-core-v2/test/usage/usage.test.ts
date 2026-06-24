import { describe, expect, it } from 'vitest';

import { UsageService } from '#/usage/usageService';

describe('UsageService', () => {
  it('accumulates input/output tokens', () => {
    const svc = new UsageService(undefined as never, undefined as never);
    svc.record(10, 5);
    svc.record(3, 2);
    expect(svc.totals).toEqual({ inputTokens: 13, outputTokens: 7 });
  });
});
