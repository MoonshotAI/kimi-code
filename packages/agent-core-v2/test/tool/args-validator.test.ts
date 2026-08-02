import { describe, expect, it } from 'vitest';

import {
  compileToolArgsValidator,
  type JsonType,
  validateToolArgs,
} from '#/tool/args-validator';

function validate(schema: Record<string, unknown>, value: JsonType): string | null {
  return validateToolArgs(compileToolArgsValidator(schema), value);
}

describe('args-validator (Ajv, format support)', () => {
  it('validates string format (email)', () => {
    const schema = { type: 'string', format: 'email' };
    expect(validate(schema, 'a@b.com')).toBeNull();
    expect(validate(schema, 'not-an-email')).toContain('format');
  });

  it('validates string format (uri)', () => {
    const schema = { type: 'string', format: 'uri' };
    expect(validate(schema, 'https://example.com/x')).toBeNull();
    expect(validate(schema, 'not a uri')).toContain('format');
  });

  it('format is ignored on non-strings', () => {
    const schema = { type: 'number', format: 'email' };
    expect(validate(schema, 42)).toBeNull();
  });

  it('keeps required / additionalProperties messages', () => {
    expect(validate({ type: 'object', required: ['a'] }, {})).toContain(
      "must have required property 'a'",
    );
    expect(
      validate({ type: 'object', properties: { a: {} }, additionalProperties: false }, { b: 1 }),
    ).toContain("must NOT have additional property 'b'");
  });

  it('still validates the JSON-Schema subset (type / enum / const)', () => {
    expect(validate({ type: 'integer' }, 1.5)).toContain('must be integer');
    expect(validate({ enum: ['a', 'b'] }, 'c')).toContain('allowed values');
    expect(validate({ const: 'x' }, 'y')).toContain('constant');
  });

  it('coerces numeric strings to numbers on validation failure', () => {
    const schema = {
      type: 'object',
      properties: {
        line_offset: { type: 'integer' },
        path: { type: 'string' },
      },
    };
    expect(validate(schema, { line_offset: '3', path: 'main.go' })).toBeNull();
    expect(validate(schema, { line_offset: 'abc', path: 'main.go' })).toContain('must be integer');
    expect(validate(schema, { line_offset: '%', path: 'main.go' })).toContain('must be integer');
  });

  it('coerces boolean strings on validation failure', () => {
    const schema = {
      type: 'object',
      properties: {
        replaceAll: { type: 'boolean' },
      },
    };
    expect(validate(schema, { replaceAll: 'true' })).toBeNull();
    expect(validate(schema, { replaceAll: 'false' })).toBeNull();
  });

  it('coerces stringified JSON arrays/objects on validation failure', () => {
    const schema = {
      type: 'object',
      properties: {
        todos: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object' },
      },
    };
    expect(validate(schema, { todos: '["a","b"]' })).toBeNull();
    expect(validate(schema, { meta: '{"key":"val"}' })).toBeNull();
    expect(validate(schema, { todos: '[broken' })).toContain('must be array');
  });

  it('does NOT coerce fields whose schema accepts strings', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line_offset: { type: 'integer' },
      },
    };
    expect(validate(schema, { path: '123', line_offset: '3' })).toBeNull();
  });

  it('reports post-coercion errors, not stale type errors', () => {
    const schema = {
      type: 'object',
      properties: {
        line_offset: { type: 'integer', minimum: 1 },
      },
    };
    const result = validate(schema, { line_offset: '0' });
    expect(result).not.toBeNull();
    expect(result).not.toContain('must be integer');
    expect(result).toContain('>= 1');
  });

  it('does NOT coerce null (unlike AJV coerceTypes)', () => {
    const schema = {
      type: 'object',
      properties: {
        content: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['content'],
    };
    expect(validate(schema, { content: null })).not.toBeNull();
    expect(validate(schema, { content: 'ok', count: null })).not.toBeNull();
  });
});
