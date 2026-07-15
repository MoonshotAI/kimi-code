import { describe, expect, it } from 'vitest';

import { formatTokens } from './formatTokens';

describe('formatTokens', () => {
  it('renders sub-k counts as-is', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(512)).toBe('512');
    expect(formatTokens(1023)).toBe('1023');
  });

  it('uses 1024-based k units', () => {
    expect(formatTokens(1024)).toBe('1k');
    expect(formatTokens(2048)).toBe('2k');
    expect(formatTokens(262144)).toBe('256k');
  });

  it('keeps one decimal under 100k', () => {
    expect(formatTokens(50552)).toBe('49.4k');
    expect(formatTokens(1536)).toBe('1.5k');
  });

  it('rounds at and above 100k', () => {
    expect(formatTokens(102400)).toBe('100k');
    expect(formatTokens(999999)).toBe('977k');
  });

  it('uses 1024-based M units, dropping a trailing ".0"', () => {
    expect(formatTokens(1048576)).toBe('1M');
    expect(formatTokens(1572864)).toBe('1.5M');
    expect(formatTokens(10485760)).toBe('10M');
  });
});
