/**
 * Shared JSON-schema helpers for the manifest generators
 * (`gen-config-manifest.mts`, `gen-wire-manifest.mts`).
 *
 * Both generators drain runtime registries that carry zod schemas and render
 * field/type sketches from their JSON Schema projection.
 */

import { z } from 'zod';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Property access shape of a JSON Schema node (avoids index-signature access). */
export interface JsonSchema {
  readonly $ref?: unknown;
  readonly $defs?: unknown;
  readonly const?: unknown;
  readonly enum?: unknown;
  readonly anyOf?: unknown;
  readonly oneOf?: unknown;
  readonly type?: unknown;
  readonly items?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly additionalProperties?: unknown;
  readonly default?: unknown;
}

export function asJsonSchema(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? (value as JsonSchema) : undefined;
}

/** Resolve a `#/$defs/<name>` reference against the root schema. */
export function resolveRef(schema: unknown, root: JsonSchema): unknown {
  const s = asJsonSchema(schema);
  if (typeof s?.$ref === 'string' && s.$ref.startsWith('#/$defs/')) {
    const defs = asJsonSchema(root.$defs);
    const name = s.$ref.slice('#/$defs/'.length);
    if (defs !== undefined && isRecord(defs) && name in defs) {
      return (defs as Record<string, unknown>)[name];
    }
  }
  return schema;
}

/** One-line type description of a JSON Schema node (`"a" | "b"`, `Foo[]`, …). */
export function describeType(
  schema: unknown,
  quoteString: (raw: string) => string = (s) => JSON.stringify(s),
): string {
  const s = asJsonSchema(schema);
  if (s === undefined) return 'any';
  if (s.$ref !== undefined) {
    return typeof s.$ref === 'string' ? (s.$ref.split('/').pop() ?? 'any') : 'any';
  }
  if (s.const !== undefined) {
    return truncate(
      typeof s.const === 'string' ? quoteString(s.const) : JSON.stringify(s.const),
      40,
    );
  }
  if (Array.isArray(s.enum)) {
    return s.enum
      .map((v) => (typeof v === 'string' ? quoteString(v) : JSON.stringify(v)))
      .join(' | ');
  }
  for (const combiner of ['anyOf', 'oneOf'] as const) {
    const subs = s[combiner];
    if (Array.isArray(subs)) return subs.map((sub) => describeType(sub, quoteString)).join(' | ');
  }
  if (s.type === 'array') return `${describeType(s.items, quoteString)}[]`;
  if (s.type === 'object') {
    // Named sub-tables (zod objects emit `additionalProperties: false`) are
    // rendered by the caller; only a schema-valued additionalProperties marks
    // a true record.
    if (isRecord(s.properties)) return 'object';
    if (isRecord(s.additionalProperties)) {
      return `record<string, ${describeType(s.additionalProperties, quoteString)}>`;
    }
    return 'object';
  }
  if (typeof s.type === 'string') return s.type;
  return 'any';
}

/** Project a zod schema to JSON Schema; `undefined` when it uses transforms. */
export function toJsonSchema(schema: unknown): JsonSchema | undefined {
  try {
    return z.toJSONSchema(schema as never) as JsonSchema;
  } catch {
    return undefined;
  }
}
