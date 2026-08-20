import { describe, expect, it } from 'vitest';

import { formatTimestamp } from '#/tui/utils/format-time';

describe('formatTimestamp', () => {
  it('returns empty string for undefined or invalid timestamps', () => {
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp(0)).toBe('');
    expect(formatTimestamp(NaN)).toBe('');
    expect(formatTimestamp(Number.MAX_VALUE)).toBe('');
  });

  it('formats today timestamp as HH:MM:SS', () => {
    const now = new Date();
    const timestamp = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      14,
      23,
      45,
    ).getTime();

    expect(formatTimestamp(timestamp)).toBe('14:23:45');
  });

  it('formats older timestamp as YYYY-MM-DD HH:MM:SS', () => {
    const oldTimestamp = new Date(2025, 4, 12, 9, 8, 7).getTime();
    expect(formatTimestamp(oldTimestamp)).toBe('2025-05-12 09:08:07');
  });

  it('appends duration in seconds when endedAtMs is provided', () => {
    const now = new Date();
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      10,
      0,
      0,
    ).getTime();
    const end = start + 3400; // 3.4 seconds -> 3s

    expect(formatTimestamp(start, end)).toBe('10:00:00 (took 3s)');

    const longEnd = start + 75000; // 75 seconds -> 1m15s
    expect(formatTimestamp(start, longEnd)).toBe('10:00:00 (took 1m15s)');
  });

  it('ignores invalid or reversed completion timestamps', () => {
    const start = new Date(2026, 7, 5, 10, 0, 0).getTime();

    expect(formatTimestamp(start, Number.MAX_VALUE)).not.toContain('(took ');
    expect(formatTimestamp(start, start - 1)).not.toContain('(took ');
  });
});
