type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonRecord = Record<string, Json>;

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

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function jsonTypeOf(value: Json): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}

function derefJsonSchema(schema: JsonRecord): JsonRecord {
  const root = structuredClone(schema);

  function resolvePointer(pointer: string): Json {
    const pathStr = pointer.replace(/^#\/?/, '');
    if (pathStr === '') {
      return root;
    }
    const parts = pathStr.split('/').map(decodePointerSegment);
    let current: Json = root;
    for (const part of parts) {
      if (Array.isArray(current)) {
        if (!/^(0|[1-9][0-9]*)$/.test(part)) {
          throw new Error(`Unable to resolve reference path: ${pointer}`);
        }
        const index = Number(part);
        if (index < 0 || index >= current.length) {
          throw new Error(`Unable to resolve reference path: ${pointer}`);
        }
        current = current[index] as Json;
        continue;
      }
      if (typeof current !== 'object' || current === null) {
        throw new Error(`Unable to resolve reference path: ${pointer}`);
      }
      if (!(part in (current as JsonRecord))) {
        throw new Error(`Unable to resolve reference path: ${pointer}`);
      }
      current = (current as JsonRecord)[part] as Json;
    }
    return current;
  }

  function traverse(node: Json, activeRefs: Set<string> = new Set()): Json {
    if (Array.isArray(node)) {
      return node.map((item) => traverse(item, activeRefs));
    }
    if (typeof node !== 'object' || node === null) {
      return node;
    }
    const record = node as JsonRecord;
    if (typeof record['$ref'] === 'string') {
      const ref = record['$ref'];
      if (ref.startsWith('#')) {
        if (activeRefs.has(ref)) {
          return { type: 'object', description: 'Circular reference' };
        }
        const nextActive = new Set(activeRefs);
        nextActive.add(ref);
        const target = traverse(resolvePointer(ref), nextActive);
        if (typeof target === 'boolean') {
          return target;
        }
        if (typeof target !== 'object' || target === null || Array.isArray(target)) {
          throw new Error('Local $ref must resolve to a JSON object or boolean');
        }
        const { $ref: _, ...rest } = record;
        const traversedRest: JsonRecord = {};
        for (const [key, value] of Object.entries(rest)) {
          traversedRest[key] = traverse(value, nextActive);
        }
        return { ...(target as JsonRecord), ...traversedRest };
      }
      return record;
    }
    const result: JsonRecord = {};
    for (const [key, value] of Object.entries(record)) {
      result[key] = traverse(value, activeRefs);
    }
    return result;
  }

  const resolved = traverse(root) as JsonRecord;
  delete resolved['$defs'];
  delete resolved['definitions'];
  return resolved;
}

function splitMixedEnum(values: Json[]): JsonRecord[] {
  const buckets = new Map<string, Json[]>();
  for (const value of values) {
    const t = jsonTypeOf(value);
    const list = buckets.get(t) ?? [];
    list.push(value);
    buckets.set(t, list);
  }
  if (buckets.has('integer') && buckets.has('number')) {
    const merged = [...(buckets.get('integer') ?? []), ...(buckets.get('number') ?? [])];
    buckets.delete('integer');
    buckets.set('number', merged);
  }
  return [...buckets.entries()].map(([type, enumValues]) => ({
    type,
    enum: enumValues,
  }));
}

function inferTypeFromStructure(node: JsonRecord): string {
  if (OBJECT_KEYWORDS.some((k) => k in node)) return 'object';
  if (ARRAY_KEYWORDS.some((k) => k in node)) return 'array';
  if (STRING_KEYWORDS.some((k) => k in node)) return 'string';
  if (NUMERIC_KEYWORDS.some((k) => k in node)) return 'number';
  return 'string';
}

function normalizeProperty(node: Json): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const record = node as JsonRecord;

  if (Array.isArray(record['type'])) {
    const types = record['type'] as Json[];
    if (types.length === 1) {
      record['type'] = types[0] as Json;
    } else if (types.length > 1) {
      if (!('anyOf' in record) && !('oneOf' in record)) {
        record['anyOf'] = types.map((t) => (typeof t === 'string' ? { type: t } : (t as Json)));
      }
      delete record['type'];
    }
  }

  if (('anyOf' in record || 'oneOf' in record) && 'type' in record) {
    const parentType = record['type'];
    delete record['type'];
    if (typeof parentType === 'string') {
      for (const key of ['anyOf', 'oneOf'] as const) {
        const branches = record[key];
        if (Array.isArray(branches)) {
          for (const branch of branches) {
            if (typeof branch === 'object' && branch !== null && !Array.isArray(branch)) {
              const branchRecord = branch as JsonRecord;
              if (
                !('type' in branchRecord) &&
                !('enum' in branchRecord) &&
                !('const' in branchRecord) &&
                !COMBINATOR_KEYS.some((k) => k in branchRecord)
              ) {
                branchRecord['type'] = parentType;
              }
            }
          }
        }
      }
    }
  }

  if (!('type' in record) && !COMBINATOR_KEYS.some((key) => key in record)) {
    const enumValues = record['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      const types = new Set(enumValues.map((v) => jsonTypeOf(v)));
      if (types.size === 1) {
        record['type'] = [...types][0]!;
      } else if (types.size === 2 && types.has('integer') && types.has('number')) {
        record['type'] = 'number';
      } else {
        record['anyOf'] = splitMixedEnum(enumValues);
        delete record['enum'];
      }
    } else if ('const' in record) {
      record['type'] = jsonTypeOf(record['const'] as Json);
    } else {
      record['type'] = inferTypeFromStructure(record);
    }
  }

  recurseSchema(record);
}

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
  if (Array.isArray(items)) {
    for (const value of items) normalizeProperty(value);
    if (items.length === 0) {
      delete record['items'];
    } else if (items.length === 1) {
      record['items'] = items[0] as Json;
    } else {
      record['items'] = { anyOf: items };
    }
  } else if (typeof items === 'object' && items !== null) {
    normalizeProperty(items);
  }

  const prefixItems = record['prefixItems'];
  if (Array.isArray(prefixItems)) {
    for (const value of prefixItems) normalizeProperty(value);
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

export function sanitizeMcpSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  const dereffed = derefJsonSchema(schema as JsonRecord);
  const cloned = structuredClone(dereffed);
  normalizeProperty(cloned);
  return cloned;
}
