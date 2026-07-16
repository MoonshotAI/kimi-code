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

  it('validates nested objects with required properties', () => {
    const schema = {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: { host: { type: 'string' }, port: { type: 'integer' } },
          required: ['host'],
          additionalProperties: false,
        },
      },
      required: ['config'],
    };
    expect(validate(schema, { config: { host: 'localhost', port: 8080 } })).toBeNull();
    expect(validate(schema, { config: { port: 8080 } })).toContain('host');
    expect(validate(schema, { config: { host: 'localhost', extra: true } })).toContain(
      'additional property',
    );
    expect(validate(schema, {})).toContain('config');
  });

  it('validates arrays with item types', () => {
    const schema = {
      type: 'array',
      items: { type: 'string' },
    };
    expect(validate(schema, ['a', 'b'])).toBeNull();
    expect(validate(schema, [1, 2])).toContain('must be string');
    expect(validate(schema, 'not-an-array')).toContain('must be array');
  });

  it('validates minLength and maxLength on strings', () => {
    expect(validate({ type: 'string', minLength: 2 }, 'ab')).toBeNull();
    expect(validate({ type: 'string', minLength: 2 }, 'a')).toContain('minLength');
    expect(validate({ type: 'string', maxLength: 3 }, 'abcd')).toContain('maxLength');
  });

  it('validates minimum and maximum on numbers', () => {
    expect(validate({ type: 'number', minimum: 0, maximum: 100 }, 50)).toBeNull();
    expect(validate({ type: 'number', minimum: 0 }, -1)).toContain('minimum');
    expect(validate({ type: 'number', maximum: 100 }, 101)).toContain('maximum');
  });

  it('validates pattern on strings', () => {
    expect(validate({ type: 'string', pattern: '^[a-z]+$' }, 'hello')).toBeNull();
    expect(validate({ type: 'string', pattern: '^[a-z]+$' }, 'Hello123')).toContain('pattern');
  });

  it('validates anyOf with multiple alternatives', () => {
    const schema = {
      anyOf: [{ type: 'string' }, { type: 'number' }],
    };
    expect(validate(schema, 'text')).toBeNull();
    expect(validate(schema, 42)).toBeNull();
    expect(validate(schema, true)).toContain('anyOf');
  });

  it('validates oneOf with exactly one match', () => {
    const schema = {
      oneOf: [
        { type: 'string', const: 'admin' },
        { type: 'string', const: 'user' },
      ],
    };
    expect(validate(schema, 'admin')).toBeNull();
    expect(validate(schema, 'user')).toBeNull();
    expect(validate(schema, 'guest')).toContain('oneOf');
  });

  it('returns null for valid null values when nullable is true', () => {
    expect(validate({ type: 'string', nullable: true }, null)).toBeNull();
  });

  it('rejects null values by default', () => {
    expect(validate({ type: 'string' }, null)).not.toBeNull();
  });

  it('validates boolean values', () => {
    expect(validate({ type: 'boolean' }, true)).toBeNull();
    expect(validate({ type: 'boolean' }, false)).toBeNull();
    expect(validate({ type: 'boolean' }, 'true')).toContain('must be boolean');
  });

  it('applies default values from the schema and then validates', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', default: 'default-name' },
        count: { type: 'integer', default: 0 },
      },
    };
    expect(validate(schema, {})).toBeNull();
    expect(validate(schema, { name: 'override', count: 5 })).toBeNull();
  });

  it('rejects an empty value array when items are required', () => {
    const schema = {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
    };
    expect(validate(schema, [])).toContain('minItems');
    expect(validate(schema, ['x'])).toBeNull();
  });
});
