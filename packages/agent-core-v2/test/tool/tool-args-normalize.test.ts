import { describe, expect, it } from 'vitest';

import { normalizeToolArgs } from '#/tool/tool-args-normalize';

describe('normalizeToolArgs', () => {
  it('returns primitive and array arguments unchanged', () => {
    expect(normalizeToolArgs(undefined, null)).toBeNull();
    expect(normalizeToolArgs(undefined, undefined)).toBeUndefined();
    expect(normalizeToolArgs(undefined, 'raw string')).toBe('raw string');
    expect(normalizeToolArgs(undefined, 42)).toBe(42);
    expect(normalizeToolArgs(undefined, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('normalizes offset and limit aliases for Read tool', () => {
    const tool = {
      name: 'Read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line_offset: { type: 'integer' },
          n_lines: { type: 'integer' },
        },
      },
    };

    const normalized = normalizeToolArgs(tool, {
      path: 'src/main.ts',
      offset: 100,
      limit: 40,
    });

    expect(normalized).toEqual({
      path: 'src/main.ts',
      line_offset: 100,
      n_lines: 40,
    });
  });

  it('normalizes start_line and parameter_offset aliases for Read', () => {
    const tool = {
      name: 'Read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line_offset: { type: 'integer' },
          n_lines: { type: 'integer' },
        },
      },
    };

    expect(
      normalizeToolArgs(tool, {
        path: 'src/main.ts',
        start_line: 15,
        limit: 10,
      }),
    ).toEqual({
      path: 'src/main.ts',
      line_offset: 15,
      n_lines: 10,
    });

    expect(
      normalizeToolArgs(tool, {
        path: 'src/main.ts',
        parameter_offset: 50,
      }),
    ).toEqual({
      path: 'src/main.ts',
      line_offset: 50,
    });
  });

  it('maps 0-based offset and start_line to 1-based line_offset', () => {
    const tool = {
      name: 'Read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line_offset: { type: 'integer' },
        },
      },
    };

    expect(
      normalizeToolArgs(tool, {
        path: 'src/main.ts',
        offset: 0,
      }),
    ).toEqual({
      path: 'src/main.ts',
      line_offset: 1,
    });

    expect(
      normalizeToolArgs(tool, {
        path: 'src/main.ts',
        start_line: 0,
      }),
    ).toEqual({
      path: 'src/main.ts',
      line_offset: 1,
    });
  });

  it('preserves negative tail line offsets', () => {
    const tool = {
      name: 'Read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line_offset: { type: 'integer' },
        },
      },
    };

    expect(
      normalizeToolArgs(tool, {
        path: 'src/main.ts',
        offset: -100,
      }),
    ).toEqual({
      path: 'src/main.ts',
      line_offset: -100,
    });
  });

  it('parses numeric string values for offset and limit', () => {
    const tool = {
      name: 'Read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line_offset: { type: 'integer' },
          n_lines: { type: 'integer' },
        },
      },
    };

    expect(
      normalizeToolArgs(tool, {
        path: 'src/main.ts',
        offset: '25',
        limit: '50',
      }),
    ).toEqual({
      path: 'src/main.ts',
      line_offset: 25,
      n_lines: 50,
    });
  });

  it('prioritizes explicit canonical properties over aliases and strips duplicates', () => {
    const tool = {
      name: 'Read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line_offset: { type: 'integer' },
          n_lines: { type: 'integer' },
        },
      },
    };

    expect(
      normalizeToolArgs(tool, {
        path: 'src/main.ts',
        line_offset: 10,
        offset: 99,
        n_lines: 20,
        limit: 99,
      }),
    ).toEqual({
      path: 'src/main.ts',
      line_offset: 10,
      n_lines: 20,
    });
  });

  it('normalizes file_path and filepath aliases to path', () => {
    const tool = {
      name: 'Write',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    };

    expect(
      normalizeToolArgs(tool, {
        file_path: 'foo.txt',
        content: 'hello',
      }),
    ).toEqual({
      path: 'foo.txt',
      content: 'hello',
    });

    expect(
      normalizeToolArgs(tool, {
        filepath: 'bar.txt',
        content: 'world',
      }),
    ).toEqual({
      path: 'bar.txt',
      content: 'world',
    });
  });

  it('strips stray description_note and details metadata fields', () => {
    const tool = {
      name: 'Read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line_offset: { type: 'integer' },
          n_lines: { type: 'integer' },
        },
      },
    };

    expect(
      normalizeToolArgs(tool, {
        path: 'src/index.ts',
        offset: 1,
        limit: 10,
        description_note: 'inspect entrypoint',
        details: 'reading initial lines',
      }),
    ).toEqual({
      path: 'src/index.ts',
      line_offset: 1,
      n_lines: 10,
    });
  });

  it('leaves unrecognized properties intact for tools without aliases', () => {
    const tool = {
      name: 'custom_tool',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
    };

    expect(
      normalizeToolArgs(tool, {
        query: 'search term',
        unknown_param: 123,
      }),
    ).toEqual({
      query: 'search term',
      unknown_param: 123,
    });
  });
});
