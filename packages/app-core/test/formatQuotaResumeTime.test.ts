import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatQuotaResumeTime } from '../src/lib/formatMessageTime';

describe('formatQuotaResumeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T11:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats same-day reset times with 24-hour Chinese and 12-hour English locale conventions', () => {
    const resetAt = new Date('2026-11-27T19:34:00.000Z').toISOString();
    expect(formatQuotaResumeTime('zh', resetAt)).toBe('19:34');
    expect(formatQuotaResumeTime('en', resetAt)).toBe('7:34 PM');
  });

  it('includes the month and day when the reset falls on another calendar day', () => {
    const resetAt = new Date('2026-11-28T09:05:00.000Z').toISOString();
    expect(formatQuotaResumeTime('zh', resetAt)).toBe('11月28日 09:05');
    expect(formatQuotaResumeTime('en', resetAt)).toBe('Nov 28, 9:05 AM');
  });

  it('returns the original value when the timestamp is invalid', () => {
    expect(formatQuotaResumeTime('en', 'not-a-date')).toBe('not-a-date');
  });
});
