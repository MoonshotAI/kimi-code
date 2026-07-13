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
