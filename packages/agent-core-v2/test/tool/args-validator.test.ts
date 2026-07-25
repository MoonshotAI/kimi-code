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
});

describe('args-validator (honest type errors)', () => {
  it('reports the received value on type failures', () => {
    expect(validate({ type: 'object', properties: { n: { type: 'integer' } } }, { n: '3' })).toBe(
      '/n must be integer (received string "3")',
    );
    expect(validate({ type: 'boolean' }, 'true')).toBe('must be boolean (received string "true")');
    expect(validate({ type: 'object', properties: { n: { type: 'number' } } }, { n: null })).toBe(
      '/n must be number (received null)',
    );
  });

  it('dedupes identical type failures from union branches', () => {
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
    const message = validate(schema, { line_offset: '3' });
    expect(message).toBe(
      '/line_offset must be integer (received string "3"); /line_offset must match a schema in anyOf',
    );
  });

  it('keeps required / additionalProperties messages free of received details', () => {
    expect(validate({ type: 'object', required: ['a'] }, {})).toBe(
      "must have required property 'a'",
    );
  });
});
