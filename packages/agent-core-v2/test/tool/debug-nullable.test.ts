import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toInputJsonSchema } from '#/tool/input-schema';

describe('debug nullable', () => {
  it('shows nullable output', () => {
    const schema = z.object({ value: z.string().nullable() });
    const json = toInputJsonSchema(schema);
    console.log("DEBUG JSON:", JSON.stringify(json, null, 2));
    const valueProp = json.properties?.value as Record<string, unknown> | undefined;
    console.log("DEBUG valueProp:", JSON.stringify(valueProp, null, 2));
    console.log("DEBUG valueProp keys:", Object.keys(valueProp ?? {}));
    expect(valueProp).toBeDefined();
  });
});