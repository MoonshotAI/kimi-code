import { describe, expect, it } from 'vitest';

import { describeReceivedValue, normalizeToolArgs } from '#/tool/args-normalize';

describe('normalizeToolArgs', () => {
  it('coerces integer strings, including negatives', () => {
    const schema = { type: 'object', properties: { line_offset: { type: 'integer' } } };
    expect(normalizeToolArgs(schema, { line_offset: '3' })).toEqual({
      args: { line_offset: 3 },
      coercions: [{ path: '/line_offset', received: 'string "3"', expected: 'integer' }],
    });
    expect(normalizeToolArgs(schema, { line_offset: '-12' }).args).toEqual({ line_offset: -12 });
  });

  it('coerces through anyOf branches (Read-style union)', () => {
    const schema = {
      type: 'object',
      properties: {
        line_offset: {
          anyOf: [
            { type: 'integer', minimum: 1 },
            { type: 'integer', minimum: -1000, maximum: -1 },
          ],
        },
      },
    };
    const result = normalizeToolArgs(schema, { line_offset: '-50' });
    expect(result.args).toEqual({ line_offset: -50 });
    expect(result.coercions).toHaveLength(1);
  });

  it('coerces number and boolean strings', () => {
    const schema = {
      type: 'object',
      properties: { temperature: { type: 'number' }, verbose: { type: 'boolean' } },
    };
    const result = normalizeToolArgs(schema, { temperature: '0.5', verbose: 'true' });
    expect(result.args).toEqual({ temperature: 0.5, verbose: true });
    expect(result.coercions.map((c) => c.expected)).toEqual(['number', 'boolean']);
  });

  it('does not coerce lossy or malformed strings', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'integer' },
        b: { type: 'integer' },
        c: { type: 'number' },
        d: { type: 'boolean' },
      },
    };
    const result = normalizeToolArgs(schema, { a: '3.5', b: '3px', c: '', d: 'yes' });
    expect(result.args).toEqual({ a: '3.5', b: '3px', c: '', d: 'yes' });
    expect(result.coercions).toHaveLength(0);
  });

  it('does not coerce beyond the safe-integer range', () => {
    const schema = { type: 'object', properties: { big: { type: 'integer' } } };
    const result = normalizeToolArgs(schema, { big: '9007199254740993' });
    expect(result.args).toEqual({ big: '9007199254740993' });
    expect(result.coercions).toHaveLength(0);

    const numberSchema = { type: 'object', properties: { big: { type: 'number' } } };
    expect(normalizeToolArgs(numberSchema, { big: '9007199254740993' }).args).toEqual({
      big: '9007199254740993',
    });
  });

  it('leaves values alone when the schema already accepts strings', () => {
    const schema = {
      type: 'object',
      properties: { id: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
    };
    const result = normalizeToolArgs(schema, { id: '3' });
    expect(result.args).toEqual({ id: '3' });
    expect(result.coercions).toHaveLength(0);
  });

  it('does not coerce strings already valid via const, enum, or unconstrained branches', () => {
    const constSchema = {
      type: 'object',
      properties: { v: { oneOf: [{ type: 'integer' }, { const: '3' }] } },
    };
    expect(normalizeToolArgs(constSchema, { v: '3' })).toEqual({ args: { v: '3' }, coercions: [] });

    const enumSchema = { type: 'object', properties: { v: { enum: ['3', 3] } } };
    expect(normalizeToolArgs(enumSchema, { v: '3' }).args).toEqual({ v: '3' });

    const openBranchSchema = {
      type: 'object',
      properties: { v: { anyOf: [{ type: 'integer' }, {}] } },
    };
    expect(normalizeToolArgs(openBranchSchema, { v: '3' }).args).toEqual({ v: '3' });
  });

  it('discovers primitive types composed with allOf', () => {
    const schema = {
      type: 'object',
      properties: { v: { allOf: [{ type: 'integer' }, { minimum: 1 }] } },
    };
    const result = normalizeToolArgs(schema, { v: '3' });
    expect(result.args).toEqual({ v: 3 });
    expect(result.coercions).toEqual([
      { path: '/v', received: 'string "3"', expected: 'integer' },
    ]);
  });

  it('leaves non-string values and $ref nodes untouched', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { $ref: '#/definitions/x' } },
    };
    const result = normalizeToolArgs(schema, { a: 3, b: '3' });
    expect(result.args).toEqual({ a: 3, b: '3' });
    expect(result.coercions).toHaveLength(0);
  });

  it('recurses into nested objects and array items', () => {
    const schema = {
      type: 'object',
      properties: {
        range: {
          type: 'object',
          properties: { start: { type: 'integer' }, end: { type: 'integer' } },
        },
        offsets: { type: 'array', items: { type: 'integer' } },
      },
    };
    const result = normalizeToolArgs(schema, {
      range: { start: '1', end: 10 },
      offsets: ['1', '2', 'x'],
    });
    expect(result.args).toEqual({ range: { start: 1, end: 10 }, offsets: [1, 2, 'x'] });
    expect(result.coercions.map((c) => c.path)).toEqual([
      '/range/start',
      '/offsets/0',
      '/offsets/1',
    ]);
  });

  it('returns the original reference when nothing was coerced', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'integer' }, offsets: { type: 'array', items: { type: 'integer' } } },
    };
    const args = { n: 3, offsets: [1, 2, 3], extra: 'kept' };
    const result = normalizeToolArgs(schema, args);
    expect(result.args).toBe(args);
    expect((result.args as typeof args).offsets).toBe(args.offsets);
    expect(normalizeToolArgs(schema, {}).coercions).toHaveLength(0);
  });

  it('under-coerces ambiguous allOf compositions instead of guessing', () => {
    const schema = {
      type: 'object',
      properties: {
        v: { allOf: [{ type: 'integer' }, { anyOf: [{ type: 'string' }, { type: 'number' }] }] },
      },
    };
    const result = normalizeToolArgs(schema, { v: '3' });
    expect(result.args).toEqual({ v: '3' });
    expect(result.coercions).toHaveLength(0);
  });
});

describe('describeReceivedValue', () => {
  it('describes JSON values for model-facing errors', () => {
    expect(describeReceivedValue('3')).toBe('string "3"');
    expect(describeReceivedValue(1.5)).toBe('number 1.5');
    expect(describeReceivedValue(false)).toBe('boolean false');
    expect(describeReceivedValue(null)).toBe('null');
    expect(describeReceivedValue(undefined)).toBe('undefined');
    expect(describeReceivedValue([])).toBe('array');
    expect(describeReceivedValue({})).toBe('object');
  });
});
