import { describe, expect, it } from 'vitest';

import { parseToolCallArguments } from '../../src/loop/tool-args-parse';

describe('parseToolCallArguments', () => {
  it('treats null or empty arguments as an empty object', () => {
    expect(parseToolCallArguments(null)).toEqual({
      success: true,
      data: {},
      parseFailed: false,
    });
    expect(parseToolCallArguments('')).toEqual({
      success: true,
      data: {},
      parseFailed: false,
    });
  });

  it('parses valid JSON', () => {
    expect(parseToolCallArguments('{"text":"hi"}')).toEqual({
      success: true,
      data: { text: 'hi' },
      parseFailed: false,
    });
  });

  it('falls back to an empty object when JSON is malformed', () => {
    expect(parseToolCallArguments('{"text":"hi",}')).toEqual({
      success: true,
      data: {},
      parseFailed: true,
      error: expect.any(String),
    });
  });

  it('falls back to an empty object for unrecoverable JSON', () => {
    const result = parseToolCallArguments('{}{');
    expect(result).toEqual({
      success: true,
      data: {},
      parseFailed: true,
      error: expect.any(String),
    });
  });

  it('parses deeply nested JSON correctly', () => {
    const result = parseToolCallArguments('{"level1":{"level2":{"level3":"deep"}}}');
    expect(result).toEqual({
      success: true,
      data: { level1: { level2: { level3: 'deep' } } },
      parseFailed: false,
    });
  });

  it('parses JSON with special unicode characters', () => {
    const result = parseToolCallArguments('{"text":"日本語 émoji 🎉"}');
    expect(result).toEqual({
      success: true,
      data: { text: '日本語 émoji 🎉' },
      parseFailed: false,
    });
  });

  it('parses JSON with numeric, boolean, and null values', () => {
    const result = parseToolCallArguments('{"count":42,"active":true,"data":null}');
    expect(result).toEqual({
      success: true,
      data: { count: 42, active: true, data: null },
      parseFailed: false,
    });
  });

  it('parses JSON with an array value', () => {
    const result = parseToolCallArguments('{"items":[1,2,3]}');
    expect(result).toEqual({
      success: true,
      data: { items: [1, 2, 3] },
      parseFailed: false,
    });
  });

  it('handles extremely long JSON strings without throwing', () => {
    const longString = 'x'.repeat(100_000);
    const json = JSON.stringify({ text: longString });
    const result = parseToolCallArguments(json);
    expect(result.success).toBe(true);
    expect(result.parseFailed).toBe(false);
    expect(result.data).toEqual({ text: longString });
  });

  it('returns parseFailed for partial truncated JSON', () => {
    const result = parseToolCallArguments('{"text":"unfinished');
    expect(result).toEqual({
      success: true,
      data: {},
      parseFailed: true,
      error: expect.any(String),
    });
  });
});
