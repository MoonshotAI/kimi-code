import { describe, expect, it } from 'vitest';

import { parseFloatEnv } from '../../src/config/resolve';
import { KimiError } from '../../src/errors';

function expectConfigInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KimiError);
    expect((error as KimiError).code).toBe('config.invalid');
    return;
  }
  throw new Error('expected function to throw');
}

describe('parseFloatEnv', () => {
  it('returns undefined when unset, empty, or blank', () => {
    expect(parseFloatEnv(undefined, 'KIMI_MODEL_TEMPERATURE')).toBeUndefined();
    expect(parseFloatEnv('', 'KIMI_MODEL_TEMPERATURE')).toBeUndefined();
    expect(parseFloatEnv('   ', 'KIMI_MODEL_TEMPERATURE')).toBeUndefined();
  });

  it('parses valid floats and integers', () => {
    expect(parseFloatEnv('0.3', 'KIMI_MODEL_TEMPERATURE')).toBe(0.3);
    expect(parseFloatEnv('1', 'KIMI_MODEL_TEMPERATURE')).toBe(1);
    expect(parseFloatEnv(' 0.95 ', 'KIMI_MODEL_TOP_P')).toBe(0.95);
    expect(parseFloatEnv('0', 'KIMI_MODEL_TEMPERATURE')).toBe(0);
  });

  it.each(['abc', '1.2.3', 'NaN', '1,5'])(
    'throws config.invalid for non-numeric value %s',
    (value) => {
      expectConfigInvalid(() => parseFloatEnv(value, 'KIMI_MODEL_TEMPERATURE'));
    },
  );

  it('parses negative float values', () => {
    expect(parseFloatEnv('-0.5', 'KIMI_MODEL_TEMPERATURE')).toBe(-0.5);
    expect(parseFloatEnv('-1', 'KIMI_MODEL_TEMPERATURE')).toBe(-1);
  });

  it('parses scientific notation', () => {
    expect(parseFloatEnv('1e5', 'KIMI_MODEL_TEMPERATURE')).toBe(100000);
    expect(parseFloatEnv('1.5e-2', 'KIMI_MODEL_TEMPERATURE')).toBe(0.015);
  });

  it('throws config.invalid for Infinity and -Infinity', () => {
    expectConfigInvalid(() => parseFloatEnv('Infinity', 'KIMI_MODEL_TEMPERATURE'));
    expectConfigInvalid(() => parseFloatEnv('-Infinity', 'KIMI_MODEL_TEMPERATURE'));
  });
});
