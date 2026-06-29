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
});
