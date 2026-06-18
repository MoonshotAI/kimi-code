import { describe, expect, it, vi } from 'vitest';
import { formatMessageTime } from '../src/lib/formatMessageTime';

// Build an ISO string for a given local date/time so tests are not sensitive
// to the runner's time zone offset.
function localIso(year: number, month: number, day: number, hour = 0, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

describe('formatMessageTime', () => {
  it('returns time only for today', () => {
    vi.setSystemTime(new Date(2026, 5, 15, 14, 32));
    const iso = localIso(2026, 6, 15, 9, 0);
    expect(formatMessageTime(iso)).toBe('09:00');
  });

  it('returns yesterday label with time', () => {
    vi.setSystemTime(new Date(2026, 5, 15, 14, 32));
    const iso = localIso(2026, 6, 14, 9, 0);
    expect(formatMessageTime(iso)).toBe('昨天 09:00');
  });

  it('returns month-day time for earlier this year', () => {
    vi.setSystemTime(new Date(2026, 5, 15, 14, 32));
    const iso = localIso(2026, 5, 1, 9, 0);
    expect(formatMessageTime(iso)).toBe('05-01 09:00');
  });

  it('returns full date time for previous year', () => {
    vi.setSystemTime(new Date(2026, 5, 15, 14, 32));
    const iso = localIso(2025, 12, 31, 9, 0);
    expect(formatMessageTime(iso)).toBe('2025-12-31 09:00');
  });

  it('uses custom yesterday label', () => {
    vi.setSystemTime(new Date(2026, 5, 15, 14, 32));
    const iso = localIso(2026, 6, 14, 9, 0);
    expect(formatMessageTime(iso, 'Yesterday')).toBe('Yesterday 09:00');
  });

  it('falls back to raw string on invalid date', () => {
    expect(formatMessageTime('not-a-date')).toBe('not-a-date');
  });
});
