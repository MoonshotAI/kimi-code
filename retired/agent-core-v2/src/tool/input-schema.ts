/**
 * `tool` domain (L3) — tool-parameter JSON Schema rendering.
 *
 * Shared helper for deriving the JSON Schema that a tool advertises to the
 * model for its parameters.
 *
 * A tool's parameter schema describes the *input* the model is expected to
 * supply. zod v4's `toJSONSchema` defaults to the *output* view, which marks
 * any field carrying a chain-tail `.default()` as `required` — producing a
 * schema that simultaneously declares a `default` and lists the field as
 * required. That contradiction also makes the runtime AJV validator reject
 * legal calls that omit the defaulted fields.
 *
 * Always render parameter schemas through this helper so the `io: 'input'`
 * view is applied uniformly and defaulted fields remain optional, while the
 * closed-object guard (`additionalProperties: false`) is kept so unknown
 * arguments are still rejected.
 */

import { z } from 'zod';

export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  });
  closeObjectNodes(jsonSchema);
  return jsonSchema;
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
  for (const child of Object.values(node)) {
    closeObjectNodes(child);
  }
}
