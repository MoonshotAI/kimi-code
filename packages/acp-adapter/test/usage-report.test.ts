import { describe, expect, it } from 'vitest';

import { usageReportToSessionUpdate, type RateLimitsReport } from '../src/events-map';

describe('usageReportToSessionUpdate', () => {
  it('emits the stable used/size frame', () => {
    const note = usageReportToSessionUpdate('sess', { contextTokens: 123, maxContextTokens: 1000 });
    expect(note.update).toMatchObject({ sessionUpdate: 'usage_update', used: 123, size: 1000 });
    expect((note.update as { _meta?: unknown })._meta).toBeUndefined();
  });

  it('attaches rate limits under _meta.kimiCode when present', () => {
    const rateLimits: RateLimitsReport = {
      summary: { used: 40, limit: 1000, window: '1w', resetAt: '2026-08-03T05:20:51Z' },
      limits: [{ name: '5h', used: 1, limit: 100, window: '5h', resetAt: '2026-08-01T10:00:00Z' }],
      booster: { balanceCents: 500, totalCents: 1000, currency: 'USD' },
    };
    const note = usageReportToSessionUpdate(
      'sess',
      { contextTokens: 1, maxContextTokens: 10 },
      rateLimits,
    );
    const meta = (note.update as { _meta?: { kimiCode?: { rateLimits?: unknown } } })._meta;
    expect(meta?.kimiCode?.rateLimits).toEqual(rateLimits);
  });
});
