import { describe, expect, it } from 'vitest';

import {
  buildToolArgsSchemaHint,
  parseOrRepairToolCallArguments,
} from '../../src/loop/tool-args-repair';

describe('parseOrRepairToolCallArguments', () => {
  it('treats null or empty arguments as an empty object', () => {
    expect(parseOrRepairToolCallArguments(null)).toEqual({
      success: true,
      data: {},
      repaired: false,
    });
    expect(parseOrRepairToolCallArguments('')).toEqual({
      success: true,
      data: {},
      repaired: false,
    });
  });

  it('parses valid JSON without repair', () => {
    expect(parseOrRepairToolCallArguments('{"text":"hi"}')).toEqual({
      success: true,
      data: { text: 'hi' },
      repaired: false,
    });
  });

  it('repairs trailing commas after JSON.parse fails', () => {
    expect(parseOrRepairToolCallArguments('{"text":"hi",}')).toEqual({
      success: true,
      data: { text: 'hi' },
      repaired: true,
      originalError: expect.any(String),
    });
  });

  it('returns the original parse error when repair cannot help', () => {
    const result = parseOrRepairToolCallArguments('{}{');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe('buildToolArgsSchemaHint', () => {
  it('summarizes required and optional properties', () => {
    const hint = buildToolArgsSchemaHint({
      type: 'object',
      properties: {
        text: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['text'],
      additionalProperties: false,
    });

    expect(hint).toContain('Expected arguments schema:');
    expect(hint).toContain('- required: text');
    expect(hint).toContain('text (string)');
    expect(hint).toContain('limit (number?)');
  });

  it('returns an empty string when there are no object properties', () => {
    expect(buildToolArgsSchemaHint({ type: 'object', additionalProperties: true })).toBe('');
  });
});
