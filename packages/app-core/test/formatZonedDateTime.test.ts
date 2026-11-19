import { describe, expect, it } from 'vitest';
import { formatZonedDateTime } from '../src/lib/formatZonedDateTime';

describe('formatZonedDateTime', () => {
  it('keeps the wall clock carried by a positive offset', () => {
    expect(formatZonedDateTime('en', '2026-09-19T15:44:00.000+08:00')).toBe('Sep 19, 2026, 15:44');
    expect(formatZonedDateTime('zh', '2026-09-19T15:44:00.000+08:00')).toBe('2026年9月19日 15:44');
  });

  it('keeps the wall clock carried by a negative offset', () => {
    expect(formatZonedDateTime('en', '2026-09-19T06:05:00.000-07:00')).toBe('Sep 19, 2026, 06:05');
    expect(formatZonedDateTime('zh', '2026-09-19T06:05:00.000-07:00')).toBe('2026年9月19日 06:05');
  });

  it('accepts an offset written without a colon and a Z suffix', () => {
    expect(formatZonedDateTime('en', '2026-09-19T15:44:00+0830')).toBe('Sep 19, 2026, 15:44');
    expect(formatZonedDateTime('en', '2026-09-19T23:10:00Z')).toBe('Sep 19, 2026, 23:10');
  });

  it('crosses the date boundary using the offset in the value, not the host zone', () => {
    expect(formatZonedDateTime('en', '2026-09-20T00:30:00.000+13:00')).toBe('Sep 20, 2026, 00:30');
    expect(formatZonedDateTime('en', '2026-09-19T23:30:00.000-11:00')).toBe('Sep 19, 2026, 23:30');
  });

  it('returns unparseable input unchanged', () => {
    expect(formatZonedDateTime('en', 'not a date')).toBe('not a date');
    expect(formatZonedDateTime('en', '')).toBe('');
  });
});
