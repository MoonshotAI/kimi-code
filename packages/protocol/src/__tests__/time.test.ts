import { describe, expect, it } from 'vitest';

import { IsoDateTime, isoDateTimeSchema, nowIsoDateTime } from '../time';

describe('time — IsoDateTime', () => {
  it('alias and schema are the same object', () => {
    expect(IsoDateTime).toBe(isoDateTimeSchema);
  });

  it('normalizes +08:00 offset to UTC `Z`', () => {
    const parsed = isoDateTimeSchema.parse('2026-06-04T18:30:00+08:00');
    expect(parsed.endsWith('Z')).toBe(true);
    expect(parsed).toBe('2026-06-04T10:30:00.000Z');
  });

  it('normalizes -05:00 offset to UTC `Z`', () => {
    const parsed = isoDateTimeSchema.parse('2026-06-04T05:30:00-05:00');
    expect(parsed).toBe('2026-06-04T10:30:00.000Z');
  });

  it('canonicalizes already-UTC input with millisecond padding', () => {
    expect(isoDateTimeSchema.parse('2026-06-04T10:30:00Z')).toBe('2026-06-04T10:30:00.000Z');
    expect(isoDateTimeSchema.parse('2026-06-04T10:30:00.5Z')).toBe('2026-06-04T10:30:00.500Z');
    expect(isoDateTimeSchema.parse('2026-06-04T10:30:00.123Z')).toBe('2026-06-04T10:30:00.123Z');
  });

  it('rejects no-offset input (offset is REQUIRED)', () => {
    expect(isoDateTimeSchema.safeParse('2026-06-04T10:30:00').success).toBe(false);
  });

  it('rejects non-ISO strings', () => {
    expect(isoDateTimeSchema.safeParse('not-a-date').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('2026/06/04 10:30:00').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('').success).toBe(false);
  });

  it('rejects unix epoch numbers (string form)', () => {
    expect(isoDateTimeSchema.safeParse('1717497000').success).toBe(false);
  });

  it('rejects ISO-shaped but invalid dates', () => {
    expect(isoDateTimeSchema.safeParse('2026-13-04T10:30:00Z').success).toBe(false);
  });

  it('nowIsoDateTime() produces a canonical-Z millisecond string', () => {
    const stamp = nowIsoDateTime();
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(isoDateTimeSchema.parse(stamp)).toBe(stamp);
  });
});
