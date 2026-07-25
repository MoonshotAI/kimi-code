/**
 * `tool` domain (L3) — pre-validation tool-args normalization.
 *
 * Model tool-call output is untrusted input: some providers emit primitive
 * arguments as JSON strings (`"3"` for an integer) instead of the declared
 * types. The harness absorbs that at the parse/validation boundary — the
 * earliest point it controls — while keeping validation itself strict.
 *
 * The rules are deliberately generic and bounded so this layer stays a single
 * schema-driven rule instead of growing into a catalog of model-specific
 * hacks:
 *   - only string → integer / number / boolean coercions are attempted
 *   - only when the coercion is lossless and the schema does not already
 *     accept strings at that position
 *   - `$ref` nodes and ambiguous (string-accepting) schemas are left alone
 *   - composition keywords are consulted for type discovery only, never as a
 *     proof of validity; under-coercion is deliberate, since whatever this
 *     layer misses still faces strict validation below
 *
 * Whatever cannot be normalized still fails validation afterwards, where the
 * error message reports what was actually received. Pure helper; no scoped
 * service.
 */

export type CoercionTarget = 'integer' | 'number' | 'boolean';

export interface ArgCoercion {
  readonly path: string;
  readonly received: string;
  readonly expected: CoercionTarget;
}

export interface ArgsNormalization {
  readonly args: unknown;
  readonly coercions: readonly ArgCoercion[];
}

const INTEGER_TEXT = /^[+-]?\d+$/;
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

type PrimitiveType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

function collectPrimitiveTypes(node: Record<string, unknown>, into: Set<PrimitiveType>): void {
  const type = node['type'];
  if (typeof type === 'string') into.add(type as PrimitiveType);
  if (Array.isArray(type)) {
    for (const entry of type) {
      if (typeof entry === 'string') into.add(entry as PrimitiveType);
    }
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (branch !== null && typeof branch === 'object' && !Array.isArray(branch)) {
          collectPrimitiveTypes(branch as Record<string, unknown>, into);
        }
      }
    }
  }
}

function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnconstrained(node: Record<string, unknown>): boolean {
  return (
    node['type'] === undefined &&
    node['const'] === undefined &&
    node['enum'] === undefined &&
    node['$ref'] === undefined
  );
}

function stringAlreadyValid(node: Record<string, unknown>, raw: string): boolean {
  if (node['const'] === raw) return true;
  const enumValues = node['enum'];
  if (Array.isArray(enumValues) && enumValues.includes(raw)) return true;
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isSchemaNode(branch)) continue;
      if (isUnconstrained(branch) || stringAlreadyValid(branch, raw)) return true;
    }
  }
  return false;
}

function coerceString(
  raw: string,
  expected: ReadonlySet<PrimitiveType>,
): { readonly value: number | boolean; readonly target: CoercionTarget } | undefined {
  if (expected.has('integer') && INTEGER_TEXT.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return { value: parsed, target: 'integer' };
    return undefined;
  }
  if (expected.has('number') && NUMBER_TEXT.test(raw)) {
    const parsed = Number(raw);
    const lossless = INTEGER_TEXT.test(raw) ? Number.isSafeInteger(parsed) : Number.isFinite(parsed);
    if (lossless) return { value: parsed, target: 'number' };
    return undefined;
  }
  if (expected.has('boolean') && (raw === 'true' || raw === 'false')) {
    return { value: raw === 'true', target: 'boolean' };
  }
  return undefined;
}

export function describeReceivedValue(value: unknown): string {
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `number ${String(value)}`;
  if (typeof value === 'boolean') return `boolean ${String(value)}`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return 'object';
}

function normalizeValue(
  node: Record<string, unknown>,
  value: unknown,
  path: string,
  coercions: ArgCoercion[],
): unknown {
  if (typeof value === 'string') {
    const expected = new Set<PrimitiveType>();
    collectPrimitiveTypes(node, expected);
    if (!expected.has('string') && !stringAlreadyValid(node, value)) {
      const coerced = coerceString(value, expected);
      if (coerced !== undefined) {
        coercions.push({
          path,
          received: describeReceivedValue(value),
          expected: coerced.target,
        });
        return coerced.value;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    const items = node['items'];
    if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
      const itemSchema = items as Record<string, unknown>;
      if (itemSchema['$ref'] === undefined) {
        let changed: unknown[] | undefined;
        for (let index = 0; index < value.length; index += 1) {
          const normalized = normalizeValue(
            itemSchema,
            value[index],
            `${path}/${String(index)}`,
            coercions,
          );
          if (normalized !== value[index]) {
            changed ??= [...value];
            changed[index] = normalized;
          }
        }
        return changed ?? value;
      }
    }
    return value;
  }

  if (value !== null && typeof value === 'object') {
    const properties = node['properties'];
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      const record = value as Record<string, unknown>;
      let changed: Record<string, unknown> | undefined;
      for (const [key, child] of Object.entries(properties)) {
        if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
        const childSchema = child as Record<string, unknown>;
        if (childSchema['$ref'] !== undefined) continue;
        if (!(key in record)) continue;
        const normalized = normalizeValue(
          childSchema,
          record[key],
          `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
          coercions,
        );
        if (normalized !== record[key]) {
          changed ??= { ...record };
          changed[key] = normalized;
        }
      }
      return changed ?? value;
    }
    return value;
  }

  return value;
}

export function normalizeToolArgs(
  schema: Record<string, unknown>,
  args: unknown,
): ArgsNormalization {
  const coercions: ArgCoercion[] = [];
  if (schema['$ref'] !== undefined) return { args, coercions };
  const normalized = normalizeValue(schema, args, '', coercions);
  return { args: normalized, coercions };
}
