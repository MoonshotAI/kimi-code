import { describe, expect, it } from 'vitest';

import { applyToolArgAliases, parseToolCallArguments } from '#/tool/tool-args-parse';

describe('parseToolCallArguments', () => {
  it('returns an empty object for empty string input', () => {
    expect(parseToolCallArguments('')).toEqual({ data: {}, parseFailed: false });
  });

  it('parses a JSON string into an object', () => {
    expect(parseToolCallArguments('{"offset": 10}')).toEqual({
      data: { offset: 10 },
      parseFailed: false,
    });
  });

  it('reports a parse failure for malformed JSON', () => {
    const result = parseToolCallArguments('{not json');
    expect(result.parseFailed).toBe(true);
    expect(result.error).toBeDefined();
  });
});

describe('applyToolArgAliases', () => {
  const readAliases = { offset: 'line_offset', limit: 'n_lines' } as const;

  it('returns args unchanged when no aliases are configured', () => {
    const args = { offset: 10 };
    expect(applyToolArgAliases(undefined, args)).toBe(args);
  });

  it('maps an alias to its canonical name when the canonical name is absent', () => {
    expect(applyToolArgAliases(readAliases, { offset: 10 })).toEqual({ line_offset: 10 });
    expect(applyToolArgAliases(readAliases, { limit: 20 })).toEqual({ n_lines: 20 });
  });

  it('maps both aliases at once and preserves unrelated arguments', () => {
    expect(
      applyToolArgAliases(readAliases, { path: 'a.txt', offset: 10, limit: 20 }),
    ).toEqual({ path: 'a.txt', line_offset: 10, n_lines: 20 });
  });

  it('keeps an explicitly provided canonical value and drops the alias', () => {
    expect(applyToolArgAliases(readAliases, { offset: 10, line_offset: 5 })).toEqual({
      line_offset: 5,
    });
  });

  it('drops the alias key even when the canonical value is already present', () => {
    expect(
      applyToolArgAliases(readAliases, { offset: 10, line_offset: 5, n_lines: 3 }),
    ).toEqual({ line_offset: 5, n_lines: 3 });
  });

  it('does not mutate the input object', () => {
    const args = { offset: 10 };
    applyToolArgAliases(readAliases, args);
    expect(args).toEqual({ offset: 10 });
  });

  it('returns non-object inputs unchanged', () => {
    expect(applyToolArgAliases(readAliases, null)).toBeNull();
    expect(applyToolArgAliases(readAliases, 'x')).toBe('x');
    expect(applyToolArgAliases(readAliases, [1, 2])).toEqual([1, 2]);
  });
});
