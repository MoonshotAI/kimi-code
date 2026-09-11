import { describe, expect, it } from 'vitest';

import { parseBooleanEnv, parseNonNegativeIntEnv, parsePositiveIntEnv } from '#/_base/utils/env';

describe('parseNonNegativeIntEnv', () => {
  it.each([undefined, '', 'abc', '-1', '1.5', '1e3'])('rejects %j', (value) => {
    expect(parseNonNegativeIntEnv(value)).toBeUndefined();
  });

  it('accepts zero and trims surrounding whitespace', () => {
    expect(parseNonNegativeIntEnv('0')).toBe(0);
    expect(parseNonNegativeIntEnv(' 32 ')).toBe(32);
  });
});

describe('parsePositiveIntEnv', () => {
  it('rejects zero but keeps positive integers', () => {
    expect(parsePositiveIntEnv('0')).toBeUndefined();
    expect(parsePositiveIntEnv('7')).toBe(7);
  });
});

describe('parseBooleanEnv', () => {
  it.each(['1', 'true', 'yes', 'on'])('parses %j as true', (value) => {
    expect(parseBooleanEnv(value)).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off'])('parses %j as false', (value) => {
    expect(parseBooleanEnv(value)).toBe(false);
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(parseBooleanEnv('  TRUE  ')).toBe(true);
    expect(parseBooleanEnv('\tOff\n')).toBe(false);
  });

  it.each([undefined, '', '   '])('treats empty input %j as undefined', (value) => {
    expect(parseBooleanEnv(value)).toBeUndefined();
  });

  it.each(['flase', 'maybe', '2', 'true false'])('returns undefined for unparseable %j', (value) => {
    expect(parseBooleanEnv(value)).toBeUndefined();
  });
});
