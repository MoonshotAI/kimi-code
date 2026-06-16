/**
 * Sanitize standard JSON Schemas emitted by MCP servers into the stricter
 * "Moonshot Flavored JSON Schema" (MFJS) the Kimi API validator expects.
 *
 * ## Background
 *
 * MCP servers advertise tool input schemas as standard JSON Schema objects.
 * Standard JSON Schema permits property schemas that omit the `type` keyword
 * (e.g. `{"enum": ["a", "b"]}`) and freely uses combinators (`anyOf`,
 * `oneOf`, `allOf`) and `$ref` indirection. Most LLM providers (OpenAI,
 * Anthropic) accept these without issue.
 *
 * Moonshot's validator is stricter: every property must carry an explicit
 * `type`, and `$ref` pointers must be resolved inline. Without sanitization
 * the API returns HTTP 400:
 *
 * > tools.function.parameters is not a valid moonshot flavored json schema,
 * > details: <At path 'properties.X': type is not defined>
 *
 * This module is a TypeScript port of the original kosong interceptor that
 * shipped in the Python-based kimi-cli (`kosong/utils/jsonschema.py`).
 *
 * ## What it does
 *
 * 1. **Dereferences local `$ref`** entries (`#/$defs/...`) so the resolved
 *    schema contains no indirection, then strips the definition buckets.
 * 2. **Fills in missing `type`** on every property schema — inferred from
 *    `enum`/`const` values, from structural keywords (`properties` →
 *    `"object"`, `items` → `"array"`, etc.), or defaulting to `"string"`.
 *
 * Combinator branches (`anyOf`/`oneOf`/`allOf`/`$ref`/`not`/`if`/`then`/
 * `else`) are left alone because they legitimately describe shape without
 * `type`.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonRecord = Record<string, Json>;

/**
 * JSON Schema keywords that describe a property's shape without (or in
 * addition to) a `type` keyword. When any of these are present we skip the
 * type-filling step so we don't distort the schema's meaning.
 */
const COMBINATOR_KEYS = [
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$ref',
] as const;

const OBJECT_KEYWORDS = [
  'properties',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'required',
  'minProperties',
  'maxProperties',
] as const;

const ARRAY_KEYWORDS = [
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
] as const;

const STRING_KEYWORDS = ['minLength', 'maxLength', 'pattern', 'format'] as const;

const NUMERIC_KEYWORDS = [
  'minimum',
  'maximum',
  'multipleOf',
  'exclusiveMinimum',
  'exclusiveMaximum',
] as const;

/**
 * Resolve local `$ref` entries inside a JSON Schema, then return a deep copy
 * with every reference inlined and the definition buckets removed.
 *
 * Only local references (those starting with `#`) are resolved; remote
 * references (e.g. `https://...`) are left untouched.
 *
 * @throws if a local `$ref` cannot be resolved or resolves to a non-object.
 */
function derefJsonSchema(schema: JsonRecord): JsonRecord {
  const root = structuredClone(schema);

  function resolvePointer(pointer: string): Json {
    const parts = pointer.replace(/^#\/?/, '').split('/');
    let current: Json = root;
    for (const part of parts) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new Error(`Unable to resolve reference path: ${pointer}`);
      }
      current = (current as JsonRecord)[part] ?? null;
      if (current === undefined) {
        throw new Error(`Unable to resolve reference path: ${pointer}`);
      }
    }
    return current;
  }

  function traverse(node: Json): Json {
    if (Array.isArray(node)) {
      return node.map(traverse);
    }
    if (typeof node !== 'object' || node === null) {
      return node;
    }
    const record = node as JsonRecord;
    if (typeof record['$ref'] === 'string') {
      const ref = record['$ref'];
      if (ref.startsWith('#')) {
        const target = traverse(resolvePointer(ref));
        if (typeof target !== 'object' || target === null || Array.isArray(target)) {
          throw new Error('Local $ref must resolve to a JSON object');
        }
        const { $ref: _, ...rest } = record;
        return { ...(target as JsonRecord), ...rest };
      }
      // Remote reference — leave as-is.
      return record;
    }
    const result: JsonRecord = {};
    for (const [key, value] of Object.entries(record)) {
      result[key] = traverse(value);
    }
    return result;
  }

  const resolved = traverse(root) as JsonRecord;
  delete resolved['$defs'];
  delete resolved['definitions'];
  return resolved;
}

/**
 * Walk into every property-schema position under `node` and ensure each
 * declares a `type`. Mutates the node in place (the caller should pass a
 * deep clone).
 *
 * Property-schema positions are: values under `properties`, entries in
 * `items` (object or array form), `additionalProperties` (object form), and
 * branches of `anyOf`/`oneOf`/`allOf`.
 *
 * `node` itself is treated as a container and is not normalized — only the
 * property schemas it contains are.
 */
function recurseSchema(node: Json): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const record = node as JsonRecord;

  const props = record['properties'];
  if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
    for (const value of Object.values(props as JsonRecord)) {
      normalizeProperty(value);
    }
  }

  const items = record['items'];
  if (typeof items === 'object' && items !== null) {
    if (Array.isArray(items)) {
      for (const value of items) normalizeProperty(value);
    } else {
      normalizeProperty(items);
    }
  }

  const additional = record['additionalProperties'];
  if (typeof additional === 'object' && additional !== null && !Array.isArray(additional)) {
    normalizeProperty(additional);
  }

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = record[key];
    if (Array.isArray(branches)) {
      for (const value of branches) normalizeProperty(value);
    }
  }
}

/**
 * Ensure `node` (a property schema) declares a `type`, then recurse into it.
 */
function normalizeProperty(node: Json): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const record = node as JsonRecord;

  if (!('type' in record) && !COMBINATOR_KEYS.some((key) => key in record)) {
    const enumValues = record['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      record['type'] = inferTypeFromValues(enumValues);
    } else if ('const' in record) {
      record['type'] = inferTypeFromValues([record['const']]);
    } else {
      record['type'] = inferTypeFromStructure(record);
    }
  }

  recurseSchema(record);
}

/**
 * Infer a JSON Schema `type` from structural keywords present on `node`.
 *
 * Falls back to `"string"` only when the node carries no structural hints.
 */
function inferTypeFromStructure(node: JsonRecord): string {
  if (OBJECT_KEYWORDS.some((k) => k in node)) return 'object';
  if (ARRAY_KEYWORDS.some((k) => k in node)) return 'array';
  if (STRING_KEYWORDS.some((k) => k in node)) return 'string';
  if (NUMERIC_KEYWORDS.some((k) => k in node)) return 'number';
  return 'string';
}

/**
 * Infer a JSON Schema `type` string from a list of concrete values.
 *
 * - Single type → return it.
 * - `{integer, number}` → `"number"` (integer is a subset of number).
 * - Mixed → `"string"`.
 */
function inferTypeFromValues(values: Json[]): string {
  const inferred = new Set<string>();
  for (const value of values) {
    if (typeof value === 'boolean') inferred.add('boolean');
    else if (typeof value === 'number') {
      inferred.add(Number.isInteger(value) ? 'integer' : 'number');
    } else if (typeof value === 'string') inferred.add('string');
    else if (value === null) inferred.add('null');
    else if (Array.isArray(value)) inferred.add('array');
    else if (typeof value === 'object') inferred.add('object');
    else return 'string';
  }
  if (inferred.size === 1) return [...inferred][0]!;
  if (inferred.size === 2 && inferred.has('integer') && inferred.has('number')) return 'number';
  return 'string';
}

/**
 * Sanitize a standard JSON Schema (as emitted by MCP servers) into
 * Moonshot Flavored JSON Schema: resolve local `$ref` pointers and fill in
 * missing `type` declarations on every property.
 *
 * Returns a **new** object; the input is never mutated. Non-object inputs
 * are returned unchanged so callers can use this as an identity pass-through
 * for edge cases (MCP servers occasionally emit `true` or `false` as a
 * schema).
 */
export function sanitizeMcpSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  const dereffed = derefJsonSchema(schema as JsonRecord);
  const cloned = structuredClone(dereffed);
  recurseSchema(cloned);
  return cloned;
}
