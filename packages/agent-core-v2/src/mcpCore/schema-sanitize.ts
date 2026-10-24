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
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
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
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  return decoded.replaceAll('~1', '/').replaceAll('~0', '~');
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

function conjoinBounds(
  target: JsonRecord,
  rest: JsonRecord,
  merged: JsonRecord,
  key: string,
  op: 'min' | 'max',
): void {
  const a = target[key];
  const b = rest[key];
  if (typeof a === 'number' && typeof b === 'number') {
    merged[key] = op === 'max' ? Math.max(a, b) : Math.min(a, b);
  }
}

function jsonEquals(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEquals(a[i] as Json, b[i] as Json)) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    if (Array.isArray(b) || typeof b !== 'object') return false;
    const aRec = a as JsonRecord;
    const bRec = b as JsonRecord;
    const aKeys = Object.keys(aRec);
    const bKeys = Object.keys(bRec);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.hasOwn(bRec, key)) return false;
      if (!jsonEquals(aRec[key] as Json, bRec[key] as Json)) return false;
    }
    return true;
  }
  return false;
}

function mergeRefSiblings(target: JsonRecord, rest: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...target, ...rest };

  conjoinBounds(target, rest, merged, 'minLength', 'max');
  conjoinBounds(target, rest, merged, 'maxLength', 'min');
  conjoinBounds(target, rest, merged, 'minimum', 'max');
  conjoinBounds(target, rest, merged, 'maximum', 'min');
  conjoinBounds(target, rest, merged, 'exclusiveMinimum', 'max');
  conjoinBounds(target, rest, merged, 'exclusiveMaximum', 'min');
  conjoinBounds(target, rest, merged, 'minItems', 'max');
  conjoinBounds(target, rest, merged, 'maxItems', 'min');
  conjoinBounds(target, rest, merged, 'minProperties', 'max');
  conjoinBounds(target, rest, merged, 'maxProperties', 'min');

  if (Array.isArray(target['enum']) && Array.isArray(rest['enum'])) {
    const restList = rest['enum'] as Json[];
    merged['enum'] = (target['enum'] as Json[]).filter((x) =>
      restList.some((y) => jsonEquals(x, y)),
    );
  }

  if (Array.isArray(target['required']) || Array.isArray(rest['required'])) {
    const targetReq = Array.isArray(target['required']) ? target['required'] : [];
    const restReq = Array.isArray(rest['required']) ? rest['required'] : [];
    const reqSet = new Set<string>();
    for (const item of targetReq) {
      if (typeof item === 'string') reqSet.add(item);
    }
    for (const item of restReq) {
      if (typeof item === 'string') reqSet.add(item);
    }
    merged['required'] = Array.from(reqSet);
  }

  if (
    typeof target['properties'] === 'object' &&
    target['properties'] !== null &&
    !Array.isArray(target['properties']) &&
    typeof rest['properties'] === 'object' &&
    rest['properties'] !== null &&
    !Array.isArray(rest['properties'])
  ) {
    const targetProps = target['properties'] as JsonRecord;
    const restProps = rest['properties'] as JsonRecord;
    const mergedProps: JsonRecord = { ...targetProps };
    for (const [key, value] of Object.entries(restProps)) {
      if (
        key in mergedProps &&
        typeof mergedProps[key] === 'object' &&
        mergedProps[key] !== null &&
        !Array.isArray(mergedProps[key]) &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        mergedProps[key] = mergeRefSiblings(mergedProps[key] as JsonRecord, value as JsonRecord);
      } else {
        mergedProps[key] = value;
      }
    }
    merged['properties'] = mergedProps;
  }

  return merged;
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
        const { $ref: _, ...rest } = record;
        const traversedRest: JsonRecord = {};
        for (const [key, value] of Object.entries(rest)) {
          traversedRest[key] = traverse(value, activeRefs);
        }
        if (typeof target === 'boolean') {
          if (!target) return false;
          return Object.keys(traversedRest).length > 0 ? traversedRest : true;
        }
        if (typeof target !== 'object' || target === null || Array.isArray(target)) {
          throw new Error('Local $ref must resolve to a JSON object or boolean');
        }
        return mergeRefSiblings(target as JsonRecord, traversedRest);
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

function isBranchCompatibleWithTypeSet(
  branch: Json,
  allowedTypes: Set<string>,
): boolean {
  if (typeof branch === 'string') {
    return allowedTypes.has(branch) || (branch === 'integer' && allowedTypes.has('number'));
  }
  if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) {
    return true;
  }
  const b = branch as JsonRecord;
  if (typeof b['type'] === 'string') {
    return (
      allowedTypes.has(b['type']) ||
      (b['type'] === 'integer' && allowedTypes.has('number'))
    );
  }
  if (Array.isArray(b['type'])) {
    return (b['type'] as Json[]).some(
      (t) =>
        typeof t === 'string' &&
        (allowedTypes.has(t) || (t === 'integer' && allowedTypes.has('number'))),
    );
  }
  if ('const' in b) {
    const t = jsonTypeOf(b['const'] as Json);
    return allowedTypes.has(t) || (t === 'integer' && allowedTypes.has('number'));
  }
  if (Array.isArray(b['enum'])) {
    return (b['enum'] as Json[]).some((val) => {
      const t = jsonTypeOf(val);
      return allowedTypes.has(t) || (t === 'integer' && allowedTypes.has('number'));
    });
  }
  return true;
}

function normalizeProperty(node: Json): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const record = node as JsonRecord;

  if (Array.isArray(record['type'])) {
    const types = record['type'] as Json[];
    if ('anyOf' in record || 'oneOf' in record) {
      const allowedTypes = new Set(
        types.filter((t): t is string => typeof t === 'string'),
      );
      for (const key of ['anyOf', 'oneOf'] as const) {
        const branches = record[key];
        if (Array.isArray(branches)) {
          const filteredBranches: Json[] = [];
          for (const branch of branches) {
            if (isBranchCompatibleWithTypeSet(branch, allowedTypes)) {
              if (typeof branch === 'object' && branch !== null && !Array.isArray(branch)) {
                const b = branch as JsonRecord;
                if (Array.isArray(b['type'])) {
                  const narrowed = (b['type'] as Json[]).filter(
                    (t) =>
                      typeof t === 'string' &&
                      (allowedTypes.has(t) || (t === 'integer' && allowedTypes.has('number'))),
                  );
                  if (narrowed.length === 1) {
                    b['type'] = narrowed[0] as Json;
                  } else {
                    b['type'] = narrowed;
                  }
                }
                if (Array.isArray(b['enum'])) {
                  b['enum'] = (b['enum'] as Json[]).filter((val) => {
                    const t = jsonTypeOf(val);
                    return allowedTypes.has(t) || (t === 'integer' && allowedTypes.has('number'));
                  });
                }
                if (
                  !('type' in b) &&
                  !('enum' in b) &&
                  !('const' in b) &&
                  !COMBINATOR_KEYS.some((k) => k in b) &&
                  allowedTypes.size === 1
                ) {
                  b['type'] = [...allowedTypes][0]!;
                }
              }
              filteredBranches.push(branch);
            }
          }
          record[key] = filteredBranches;
        }
      }
      delete record['type'];
    } else if (types.length === 1) {
      record['type'] = types[0] as Json;
    } else if (types.length > 1) {
      record['anyOf'] = types.map((t) => (typeof t === 'string' ? { type: t } : (t as Json)));
      delete record['type'];
    } else {
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

  const prefixItems = record['prefixItems'];
  if (Array.isArray(prefixItems)) {
    for (const value of prefixItems) normalizeProperty(value);
    const hadItemsFalse = record['items'] === false;
    if (!('items' in record) || typeof record['items'] === 'boolean') {
      if (prefixItems.length === 0) {
        delete record['items'];
      } else if (prefixItems.length === 1) {
        record['items'] = prefixItems[0] as Json;
      } else {
        record['items'] = { anyOf: prefixItems };
      }
    } else if (typeof record['items'] === 'object' && record['items'] !== null) {
      const existingItems = record['items'];
      const combined = [...prefixItems, existingItems];
      record['items'] = { anyOf: combined };
    }
    if (hadItemsFalse) {
      record['maxItems'] =
        typeof record['maxItems'] === 'number'
          ? Math.min(record['maxItems'], prefixItems.length)
          : prefixItems.length;
    }
    delete record['prefixItems'];
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
  } else if (items === false) {
    record['maxItems'] = 0;
    delete record['items'];
  } else if (items === true || (items !== undefined && typeof items !== 'object')) {
    delete record['items'];
  }

  const additional = record['additionalProperties'];
  if (typeof additional === 'object' && additional !== null && !Array.isArray(additional)) {
    normalizeProperty(additional);
  }

  for (const key of ['not', 'if', 'then', 'else', 'contains'] as const) {
    const child = record[key];
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      normalizeProperty(child);
    }
  }

  for (const key of ['patternProperties', 'dependentSchemas', 'dependencies'] as const) {
    const map = record[key];
    if (typeof map === 'object' && map !== null && !Array.isArray(map)) {
      for (const value of Object.values(map as JsonRecord)) {
        normalizeProperty(value);
      }
    }
  }

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = record[key];
    if (Array.isArray(branches)) {
      const normalizedBranches: Json[] = [];
      for (const value of branches) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          normalizeProperty(value);
          normalizedBranches.push(value);
        } else if (typeof value === 'string') {
          normalizedBranches.push({ type: value });
        } else if (typeof value === 'boolean') {
          normalizedBranches.push(value);
        }
      }
      record[key] = normalizedBranches;
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
