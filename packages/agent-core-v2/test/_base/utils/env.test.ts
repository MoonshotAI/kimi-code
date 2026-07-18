import { describe, expect, it } from 'vitest';

import { parseBooleanEnv } from '#/_base/utils/env';

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
