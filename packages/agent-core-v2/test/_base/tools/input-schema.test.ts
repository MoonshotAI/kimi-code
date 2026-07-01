import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  compileToolArgsValidator,
  validateToolArgs,
} from '#/_base/tools/args-validator';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';

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
});
