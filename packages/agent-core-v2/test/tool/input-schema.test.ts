import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  compileToolArgsValidator,
  validateToolArgs,
} from '#/tool/args-validator';
import { toInputJsonSchema } from '#/tool/input-schema';

function collectRequired(schema: unknown, acc: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRequired(item, acc);
    return acc;
  }
  if (typeof schema !== 'object' || schema === null) return acc;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required' && Array.isArray(value)) {
      for (const name of value) if (typeof name === 'string') acc.push(name);
    } else {
      collectRequired(value, acc);
    }
  }
  return acc;
}

describe('tool input JSON Schema', () => {
  const inputSchema = z
    .object({
      mode: z.enum(['read', 'write']).default('read'),
      items: z
        .array(
          z
            .object({
              label: z.string(),
              description: z.string().default(''),
            })
            .strict(),
        )
        .default([]),
    })
    .strict();

  it('keeps defaulted fields out of `required`', () => {
    const schema = toInputJsonSchema(inputSchema);
    const required = collectRequired(schema);

    expect(required).not.toContain('mode');
    expect(required).not.toContain('items');
    expect(required).not.toContain('description');
    expect(required).toContain('label');
  });

  it('accepts an empty object through runtime argument validation', () => {
    const schema = toInputJsonSchema(inputSchema);
    const validator = compileToolArgsValidator(schema);

    expect(validateToolArgs(validator, {})).toBeNull();
  });

  it('rejects an unknown top-level argument through runtime validation', () => {
    const schema = toInputJsonSchema(inputSchema);
    const validator = compileToolArgsValidator(schema);

    expect(validateToolArgs(validator, { bogus: true })).not.toBeNull();
  });

  it('rejects an unknown nested argument through runtime validation', () => {
    const schema = toInputJsonSchema(inputSchema);
    const validator = compileToolArgsValidator(schema);

    expect(
      validateToolArgs(validator, {
        items: [{ label: 'A', bogus: true }],
      }),
    ).not.toBeNull();
  });

  it('adds a top-level object type to union schemas', () => {
    const schema = toInputJsonSchema(
      z.union([
        z.object({ kind: z.literal('a'), value: z.string() }).strict(),
        z.object({ kind: z.literal('b'), count: z.number() }).strict(),
      ]),
    );

    expect(schema['type']).toBe('object');
    expect(Array.isArray(schema['anyOf'])).toBe(true);
  });

  it('adds a top-level object type to discriminated union schemas', () => {
    const schema = toInputJsonSchema(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), value: z.string() }).strict(),
        z.object({ kind: z.literal('b'), count: z.number() }).strict(),
      ]),
    );

    expect(schema['type']).toBe('object');
    expect(Array.isArray(schema['oneOf'])).toBe(true);
  });

  it('keeps union branch inputs valid through runtime validation', () => {
    const schema = toInputJsonSchema(
      z.union([
        z.object({ kind: z.literal('a'), value: z.string() }).strict(),
        z.object({ kind: z.literal('b'), count: z.number() }).strict(),
      ]),
    );
    const validator = compileToolArgsValidator(schema);

    expect(validateToolArgs(validator, { kind: 'a', value: 'x' })).toBeNull();
    expect(validateToolArgs(validator, { kind: 'b', count: 1 })).toBeNull();
    expect(validateToolArgs(validator, { kind: 'a', value: 'x', bogus: true })).not.toBeNull();
    expect(validateToolArgs(validator, { kind: 'c' })).not.toBeNull();
  });
});
