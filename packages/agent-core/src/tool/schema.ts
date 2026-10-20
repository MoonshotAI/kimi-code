import { z } from 'zod';

import type { ToolSchema } from './contract';

export function zodSchema<S extends z.ZodType>(schema: S): ToolSchema<z.infer<S>> {
  return {
    jsonSchema: toJsonSchema(schema),
    parse: (value) => {
      const result = schema.safeParse(value);
      return result.success ? result.data : undefined;
    },
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-07', io: 'input' });
  if (typeof jsonSchema !== 'object' || jsonSchema === null) {
    throw new TypeError('tool schema did not produce a JSON schema object');
  }
  const record = jsonSchema as Record<string, unknown>;
  delete record['$schema'];
  closeObjectNodes(record);
  return record;
}

function closeObjectNodes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) closeObjectNodes(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (node['type'] === 'object' && node['additionalProperties'] === undefined) {
    node['additionalProperties'] = false;
  }
  for (const child of Object.values(node)) closeObjectNodes(child);
}
