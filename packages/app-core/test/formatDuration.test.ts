import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDuration } from '../src/lib/formatDuration';

describe('formatDuration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formats English with narrow style and spaces between units', () => {
    expect(formatDuration(45_000, 'en')).toBe('45s');
    expect(formatDuration(45_000, 'en-US')).toBe('45s');
    expect(formatDuration(297_000, 'en')).toBe('4m 57s');
    expect(formatDuration((60 + 5) * 60_000, 'en')).toBe('1h 5m');
    expect(formatDuration(2_877_480_000, 'en')).toBe('33d 7h');
  });

  it('formats Chinese with short style and spaces around each unit', () => {
    expect(formatDuration(45_000, 'zh')).toBe('45 秒');
    expect(formatDuration(45_000, 'zh-CN')).toBe('45 秒');
    expect(formatDuration(297_000, 'zh')).toBe('4 分钟 57 秒');
    expect(formatDuration((60 + 5) * 60_000, 'zh-CN')).toBe('1 小时 5 分钟');
    expect(formatDuration(2_877_480_000, 'zh')).toBe('33 天 7 小时');
  });

  it('handles minute, hour, and day boundaries with whole-second flooring', () => {
    const cases: Array<[number, string, string]> = [
      [0, '', ''],
      [999, '', ''],
      [1_000, '1s', '1 秒'],
      [59_999, '59s', '59 秒'],
      [60_000, '1m', '1 分钟'],
      [3_599_999, '59m 59s', '59 分钟 59 秒'],
      [3_600_000, '1h', '1 小时'],
      [3_659_999, '1h', '1 小时'],
      [86_399_999, '23h 59m', '23 小时 59 分钟'],
      [86_400_000, '1d', '1 天'],
      [2_877_480_000, '33d 7h', '33 天 7 小时'],
    ];
    for (const [ms, en, zh] of cases) {
      expect(formatDuration(ms, 'en'), `${ms} en`).toBe(en);
      expect(formatDuration(ms, 'zh'), `${ms} zh`).toBe(zh);
    }
  });

  it('keeps at most two non-zero units at day scale and omits zero-valued units', () => {
    const threeDaysFiveMinutes = (3 * 86_400 + 5 * 60) * 1000;
    expect(formatDuration(threeDaysFiveMinutes, 'en')).toBe('3d 5m');
    expect(formatDuration(threeDaysFiveMinutes, 'zh')).toBe('3 天 5 分钟');
    expect(formatDuration(3 * 86_400_000, 'en')).toBe('3d');
    expect(formatDuration(3 * 86_400_000, 'zh')).toBe('3 天');
    expect(formatDuration((1 * 86_400 + 45) * 1000, 'en')).toBe('1d 45s');
    expect(formatDuration((1 * 86_400 + 45) * 1000, 'zh')).toBe('1 天 45 秒');
  });

  it('clamps negative and non-finite inputs safely and supports explicit zero seconds', () => {
    expect(formatDuration(-5_000, 'en')).toBe('');
    expect(formatDuration(Number.NaN, 'zh')).toBe('');
    expect(formatDuration(Number.POSITIVE_INFINITY, 'en')).toBe('');
    expect(formatDuration(0, 'en', { secondsDisplay: 'always' })).toBe('0s');
    expect(formatDuration(420, 'zh', { secondsDisplay: 'always' })).toBe('0 秒');
    expect(formatDuration(-1, 'zh', { secondsDisplay: 'always' })).toBe('0 秒');
  });

  it('falls back to ASCII concatenation with day carry when Intl.DurationFormat is unavailable', () => {
    vi.stubGlobal('Intl', { ...Intl, DurationFormat: undefined });
    expect(formatDuration(0, 'en')).toBe('');
    expect(formatDuration(999, 'zh')).toBe('');
    expect(formatDuration(0, 'en', { secondsDisplay: 'always' })).toBe('0s');
    expect(formatDuration(45_000, 'en')).toBe('45s');
    expect(formatDuration(297_000, 'en')).toBe('4m57s');
    expect(formatDuration((60 + 5) * 60_000, 'en')).toBe('1h5m');
    expect(formatDuration(2_877_480_000, 'en')).toBe('33d7h');
    expect(formatDuration(2_877_480_000, 'zh')).toBe('33d7h');
    expect(formatDuration((3 * 86_400 + 5 * 60) * 1000, 'en')).toBe('3d5m');
    expect(formatDuration(86_400_000, 'zh')).toBe('1d');
  });
});
