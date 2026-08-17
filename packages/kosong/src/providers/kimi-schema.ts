/**
 * Dereference all `$ref` references in a JSON Schema by inlining definitions
 * from local JSON pointers such as `$defs` and draft-7 `definitions`. Resolved
 * top-level definition buckets are removed from the result.
 *
 * Circular references are detected and left as `$ref` to avoid infinite
 * recursion; in that case the referenced definition bucket is preserved so the
 * remaining local `$ref` pointers stay resolvable to a JSON Schema validator.
 */
export function derefJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visited = new Set<string>();
  const result = resolveNode(schema, schema, visited) as Record<string, unknown>;

  // Only delete definition buckets if no refs into them remain in the result.
  // Cyclic refs are intentionally preserved by resolveNode() and still need
  // their definition buckets; dropping them would leave dangling pointers.
  if (!hasUnresolvedDefinitionRef(result, '$defs')) {
    delete result['$defs'];
  }
  if (!hasUnresolvedDefinitionRef(result, 'definitions')) {
    delete result['definitions'];
  }
  return result;
}

type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
type SchemaSlotKind = 'single' | 'array' | 'map' | 'schema-or-array';
type StructuralJsonSchemaType = Extract<JsonSchemaType, 'string' | 'object' | 'array'>;

interface ChildSchemaSlot {
  key: string;
  kind: SchemaSlotKind;
  parentType?: StructuralJsonSchemaType;
}

const TYPE_COMPLETION_SKIP_KEYS = new Set([
  '$ref',
  'allOf',
  'anyOf',
  'else',
  'if',
  'not',
  'oneOf',
  'then',
]);

// Moonshot rejects `type` declared next to `anyOf`/`oneOf` ("type should be
// defined in anyOf items instead of the parent schema"). `allOf` is not
// listed: a conjunction branch carrying the parent type is redundant, and the
// validator accepts `type` next to `allOf`.
const TYPE_HOISTING_COMBINATOR_KEYS = ['anyOf', 'oneOf'] as const;

// Child-schema positions that this Kimi normalizer knows how to walk. This is
// also the source of truth for child-schema keywords that imply the parent
// schema's type. It is not a list of keywords that Moonshot accepts on the wire.
const CHILD_SCHEMA_SLOTS = [
  { key: '$defs', kind: 'map' },
  { key: 'definitions', kind: 'map' },
  { key: 'dependencies', kind: 'map', parentType: 'object' },
  { key: 'dependentSchemas', kind: 'map', parentType: 'object' },
  { key: 'patternProperties', kind: 'map', parentType: 'object' },
  { key: 'properties', kind: 'map', parentType: 'object' },
  { key: 'additionalItems', kind: 'single', parentType: 'array' },
  { key: 'additionalProperties', kind: 'single', parentType: 'object' },
  { key: 'contains', kind: 'single', parentType: 'array' },
  { key: 'contentSchema', kind: 'single', parentType: 'string' },
  { key: 'else', kind: 'single' },
  { key: 'if', kind: 'single' },
  { key: 'not', kind: 'single' },
  { key: 'propertyNames', kind: 'single', parentType: 'object' },
  { key: 'then', kind: 'single' },
  { key: 'unevaluatedItems', kind: 'single', parentType: 'array' },
  { key: 'unevaluatedProperties', kind: 'single', parentType: 'object' },
  { key: 'allOf', kind: 'array' },
  { key: 'anyOf', kind: 'array' },
  { key: 'oneOf', kind: 'array' },
  { key: 'prefixItems', kind: 'array', parentType: 'array' },
  { key: 'items', kind: 'schema-or-array', parentType: 'array' },
] as const satisfies readonly ChildSchemaSlot[];

const OBJECT_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('object'),
  'dependentRequired',
  'maxProperties',
  'minProperties',
  'required',
]);

const ARRAY_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('array'),
  'maxContains',
  'maxItems',
  'minContains',
  'minItems',
  'uniqueItems',
]);

const STRING_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('string'),
  'contentEncoding',
  'contentMediaType',
  'format',
  'maxLength',
  'minLength',
  'pattern',
]);

const NUMERIC_STRUCTURE_KEYS = new Set([
  'exclusiveMaximum',
  'exclusiveMinimum',
  'maximum',
  'minimum',
  'multipleOf',
]);

/**
 * Return a deep-cloned JSON Schema with missing `type` fields filled in for
 * Kimi tool compatibility.
 *
 * Moonshot's tool validator rejects some valid JSON Schema shapes when nested
 * property schemas omit `type` (for example enum-only MCP properties). This is
 * a provider-compatibility normalizer, not a complete JSON Schema compiler:
 * it resolves local refs, preserves combinator nodes, infers obvious
 * scalar/object/array types, and falls back to `string` only for nested
 * typeless property schemas. The root schema object is treated as a container
 * and does not get a `type` defaulted onto it, but a `type` sitting next to
 * `anyOf`/`oneOf` is hoisted into the branches on every node, root included —
 * Moonshot rejects that shape outright.
 */
export function normalizeKimiToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return ensureKimiPropertyTypes(derefJsonSchema(schema));
}

function ensureKimiPropertyTypes(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = cloneJsonValue(schema);
  if (!isRecord(normalized)) {
    throw new Error('JSON Schema root must normalize to an object.');
  }
  // Hoist before type completion so a typeless branch inherits the parent's
  // authoritative type instead of a structurally inferred fallback.
  flattenRootUnion(normalized);
  hoistCombinatorTypes(normalized);
  recurseSchema(normalized);
  return normalized;
}

/**
 * Moonshot additionally requires the parameters root to carry
 * `type: "object"` while rejecting `type` next to `anyOf`, so a root-level
 * union is unrepresentable on the wire. Flatten it without narrowing what
 * the schema accepts (the wire schema may only widen — the tool's own server
 * performs the final validation): the root's own properties stay
 * authoritative and keep whatever type completion does to them, with or
 * without a union; a property defined differently across branches becomes a
 * nested `anyOf` of the distinct variants; a property is omitted rather than
 * pinned when any branch leaves it unconstrained — open additional
 * properties, a `patternProperties` bag (no regex evaluation), or a typeless
 * schema that type completion would pin to a fabricated type (bare
 * enum/const schemas keep their value-implied type); a branch that accepts
 * any object drops the branch-derived constraints entirely; `required` keeps
 * the root's own list plus fields required by every branch, minus anything
 * no longer in `properties`; per-branch `additionalProperties` is dropped.
 * The exactly-one-of intent is necessarily lost as wire-side validation and
 * stays in the description. Nested unions are untouched — only the root is
 * constrained this way.
 */
function flattenRootUnion(root: Record<string, unknown>): void {
  const variants: VariantEntry[] = [];
  let flattened = false;
  let exclusive = true;
  for (const key of TYPE_HOISTING_COMBINATOR_KEYS) {
    const value = root[key];
    if (!Array.isArray(value)) continue;
    flattened = true;
    if (key === 'anyOf') exclusive = false;
    for (const branch of value) {
      if (mayAcceptAnyObject(branch)) {
        variants.push({ kind: 'any' });
      } else if (isObjectBranch(branch)) {
        variants.push({ kind: 'object', schema: branch });
      }
      // Anything else cannot match an object and contributes nothing.
    }
    delete root[key];
  }
  if (!flattened) return;
  // One unrestricted variant means no branch-derived constraint can be
  // imposed on the root: for `anyOf` the union accepts any object, and for
  // `oneOf` it makes the other variants invalid rather than more permissive —
  // widening is the only representable outcome either way.
  const unrestricted = variants.some((variant) => variant.kind === 'any');
  const branches = unrestricted
    ? []
    : variants.flatMap((variant) => (variant.kind === 'object' ? [variant.schema] : []));

  const properties: Record<string, unknown> = isRecord(root['properties'])
    ? root['properties']
    : {};
  const requiredSets: string[][] = [];
  const branchKeys = new Set<string>();
  for (const branch of branches) {
    const branchProperties = branch['properties'];
    if (isRecord(branchProperties)) {
      for (const name of Object.keys(branchProperties)) branchKeys.add(name);
    }
    requiredSets.push(
      Array.isArray(branch['required'])
        ? branch['required'].filter((name): name is string => typeof name === 'string')
        : [],
    );
  }
  for (const name of branchKeys) {
    // The root's own property constraint already applied to every branch.
    if (hasOwn(properties, name)) continue;
    const variants = new Map<string, Record<string, unknown>>();
    let unconstrained = false;
    for (const branch of branches) {
      const branchProperties = branch['properties'];
      const patternProperties = branch['patternProperties'];
      let constraint: unknown;
      if (isRecord(branchProperties) && hasOwn(branchProperties, name)) {
        constraint = branchProperties[name];
      } else if (isRecord(patternProperties) && Object.keys(patternProperties).length > 0) {
        // A pattern may cover this key; stay conservative instead of
        // evaluating external regexes.
        constraint = true;
      } else if (hasOwn(branch, 'additionalProperties')) {
        constraint = branch['additionalProperties'];
      } else {
        constraint = true;
      }
      if (constraint === false) continue;
      if (constraint === true || (isRecord(constraint) && Object.keys(constraint).length === 0)) {
        unconstrained = true;
        break;
      }
      if (!isRecord(constraint)) continue;
      if (!hasOwn(constraint, 'type') && !hasExactValueType(constraint)) {
        // Type completion would pin a fabricated type onto a typeless schema,
        // narrowing it below the original — treat it as unconstrained.
        unconstrained = true;
        break;
      }
      variants.set(canonicalJson(constraint), constraint);
    }
    if (unconstrained) continue;
    const merged = [...variants.values()];
    const [first] = merged;
    if (merged.length === 1 && first !== undefined) {
      properties[name] = first;
    } else if (merged.length > 1) {
      properties[name] = { anyOf: merged };
    }
  }

  root['type'] = 'object';
  root['properties'] = properties;
  const alwaysRequired =
    requiredSets.length > 0
      ? requiredSets.reduce((acc, cur) => acc.filter((name) => cur.includes(name)))
      : [];
  const rootRequired = Array.isArray(root['required'])
    ? root['required'].filter((name): name is string => typeof name === 'string')
    : [];
  // A `required` naming a property that is not in `properties` is rejected
  // outright, and dropping one only widens what the wire accepts.
  const required = [...new Set([...rootRequired, ...alwaysRequired])].filter((name) =>
    hasOwn(properties, name),
  );
  if (required.length > 0) {
    root['required'] = required;
  } else {
    delete root['required'];
  }
  const summary = summarizeVariants(variants, properties, exclusive);
  if (summary !== undefined) {
    const existing = root['description'];
    root['description'] =
      typeof existing === 'string' && existing.trim() !== '' ? `${existing}\n\n${summary}` : summary;
  }
}

type VariantEntry = { kind: 'any' } | { kind: 'object'; schema: Record<string, unknown> };

/**
 * Restate the variant structure that flattening cannot express on the wire.
 * The flattened root only shows a bag of merged properties, so which field
 * combinations are actually valid — and the names of fields that had to be
 * dropped from `properties` to avoid narrowing, together with their branch
 * descriptions — survive as prose the model can read. The tool's own server
 * still performs the real validation.
 */
function summarizeVariants(
  variants: VariantEntry[],
  properties: Record<string, unknown>,
  exclusive: boolean,
): string | undefined {
  if (variants.length < 2) return undefined;
  const lines: string[] = [];
  const described: string[] = [];
  const dropped = new Map<string, string>();
  for (const [index, variant] of variants.entries()) {
    if (variant.kind === 'any') {
      described.push(`(${index + 1}) any object.`);
      continue;
    }
    const branch = variant.schema;
    const branchProperties = isRecord(branch['properties']) ? branch['properties'] : {};
    const declared = Object.keys(branchProperties);
    const required = (Array.isArray(branch['required']) ? branch['required'] : []).filter(
      (name): name is string => typeof name === 'string',
    );
    for (const name of [...required, ...declared]) {
      if (hasOwn(properties, name) || dropped.has(name)) continue;
      const entry = branchProperties[name];
      const description = isRecord(entry) ? entry['description'] : undefined;
      dropped.set(name, typeof description === 'string' ? description : '');
    }
    const parts: string[] = [];
    if (required.length > 0) parts.push(`required: ${required.join(', ')}`);
    const optional = declared.filter((name) => !required.includes(name));
    if (optional.length > 0) parts.push(`optional: ${optional.join(', ')}`);
    if (parts.length > 0) described.push(`(${index + 1}) ${parts.join('; ')}.`);
  }
  // An `anyOf` with an unrestricted variant accepts any object, so listing
  // combinations would only mislead; the dropped field names still help.
  const unrestricted = variants.some((variant) => variant.kind === 'any');
  if (described.length >= 2 && (exclusive || !unrestricted)) {
    lines.push(
      `Valid argument variants (${exclusive ? 'exactly' : 'at least'} one must match): ${described.join(' ')}`,
    );
  }
  if (dropped.size > 0) {
    lines.push(
      ['Fields without their own schema entry:']
        .concat(
          [...dropped].map(([name, description]) =>
            description === '' ? `- ${name}` : `- ${name} — ${description}`,
          ),
        )
        .join('\n'),
    );
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

/**
 * Whether a union member may match an arbitrary object. Conservative by
 * design: a member this cannot classify — an opaque combinator, an
 * unresolved `$ref`, annotations only — is reported as unrestricted so its
 * permissiveness is never silently dropped, which would let the remaining
 * members narrow the flattened root.
 */
function mayAcceptAnyObject(branch: unknown): boolean {
  if (branch === true) return true;
  if (!isRecord(branch)) return false;
  if (hasOwn(branch, 'type')) {
    const type = branch['type'];
    const includesObject =
      type === 'object' || (Array.isArray(type) && type.includes('object'));
    if (!includesObject) return false;
  }
  const values = Array.isArray(branch['enum'])
    ? branch['enum']
    : hasOwn(branch, 'const')
      ? [branch['const']]
      : undefined;
  if (values !== undefined) {
    // Fixed values only match an object when one of them is an object.
    return values.some((value) => isRecord(value));
  }
  return !hasAnyKey(branch, OBJECT_STRUCTURE_KEYS);
}

function groupValuesByType(values: unknown[]): Map<JsonSchemaType, unknown[]> | undefined {
  const groups = new Map<JsonSchemaType, unknown[]>();
  for (const value of values) {
    const valueType = inferValueType(value);
    if (valueType === undefined) return undefined;
    const bucket = groups.get(valueType);
    if (bucket === undefined) {
      groups.set(valueType, [value]);
    } else {
      bucket.push(value);
    }
  }
  return groups;
}

function hasExactValueType(schema: Record<string, unknown>): boolean {
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) return true;
  return hasOwn(schema, 'const');
}

function isObjectBranch(branch: unknown): branch is Record<string, unknown> {
  if (!isRecord(branch)) return false;
  const type = branch['type'];
  if (type === 'object' || (Array.isArray(type) && type.includes('object'))) return true;
  return !hasOwn(branch, 'type') && hasAnyKey(branch, OBJECT_STRUCTURE_KEYS);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Repair schema nodes that declare `type` next to `anyOf`/`oneOf` by moving
 * the parent `type` into the branches, preserving the parent constraint on
 * every one of them: each record branch is constrained through
 * `constrainBranchType` (dead branches are removed), a boolean `true` branch
 * becomes the bare parent constraint, and `false` branches match nothing
 * either way and are left alone. An all-dead union keeps one legal
 * never-matching `false` branch — `anyOf: []` is not valid JSON Schema.
 * Unlike type completion this pass also visits the root: MCP servers may
 * publish such roots directly, and `derefJsonSchema`'s sibling-key merge can
 * synthesize them from a root-level `$ref`.
 */
function hoistCombinatorTypes(node: Record<string, unknown>): void {
  for (const key of TYPE_HOISTING_COMBINATOR_KEYS) {
    const branches = node[key];
    if (!hasOwn(node, 'type') || !Array.isArray(branches)) continue;
    const parentType = node['type'];
    for (let i = branches.length - 1; i >= 0; i--) {
      const branch: unknown = branches[i];
      if (branch === true) {
        branches[i] = { type: cloneJsonValue(parentType) };
        continue;
      }
      // A boolean `false` (or any non-schema) branch is not accepted on the
      // wire; dropping it only widens the union.
      if (!isRecord(branch)) {
        branches.splice(i, 1);
        continue;
      }
      if (constrainBranchType(parentType, branch) === 'dead') {
        branches.splice(i, 1);
      }
    }
    if (branches.length === 0) {
      // No live branch left: drop the union and keep the parent constraint —
      // neither an empty array nor a boolean branch is a legal union member.
      delete node[key];
    } else {
      delete node['type'];
    }
  }
  visitChildSchemas(node, (child) => {
    if (isRecord(child)) {
      hoistCombinatorTypes(child);
    }
  });
}

/**
 * Constrain one union branch to the parent `type` it inherits. The parent
 * type is intersected with the branch's own `type` (when present), folding
 * the `integer ⊂ number` subtype relation; enum/const values are then judged
 * individually against that intersection — members that cannot satisfy it
 * are filtered out (a `const: 1.5` under an `integer` parent is not an
 * integer, so symmetric type algebra would widen the schema). A branch left
 * with no possible value never matched anything under the original
 * conjunction and reports 'dead'. Otherwise the branch's `type` becomes the
 * value-derived type (or the intersection when no values constrain it),
 * which also keeps the later enum/const type repair from rewriting an
 * inherited constraint.
 */
function constrainBranchType(
  parentType: unknown,
  branch: Record<string, unknown>,
): 'kept' | 'dead' {
  const parent = toTypeSet(parentType);
  if (parent === undefined) {
    // Malformed parent type — plain inheritance for typeless branches.
    if (!hasOwn(branch, 'type')) {
      branch['type'] = cloneJsonValue(parentType);
    }
    return 'kept';
  }
  let effective = parent;
  if (hasOwn(branch, 'type')) {
    const own = toTypeSet(branch['type']);
    if (own === undefined) return 'kept';
    effective = intersectTypeSets(effective, own);
  }
  if (effective.size === 0) return 'dead';

  const enumValues = branch['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const kept = enumValues.filter((value) => valueSatisfiesTypeSet(value, effective));
    if (kept.length === 0) return 'dead';
    const groups = groupValuesByType(kept);
    if (groups !== undefined && groups.size > 1 && !hasOwn(branch, 'anyOf')) {
      // A mixed-type enum cannot carry one `type`; split it into one typed
      // variant per value type instead of emitting a mixed declaration.
      delete branch['type'];
      delete branch['enum'];
      branch['anyOf'] = [...groups].map(([type, values]) => ({ type, enum: values }));
      return 'kept';
    }
    branch['enum'] = kept;
    branch['type'] = typeForValues(kept, effective);
    return 'kept';
  }
  if (hasOwn(branch, 'const')) {
    if (!valueSatisfiesTypeSet(branch['const'], effective)) return 'dead';
    branch['type'] = typeForValues([branch['const']], effective);
    return 'kept';
  }

  const types = [...effective];
  const [only] = types;
  branch['type'] = types.length === 1 && only !== undefined ? only : types;
  return 'kept';
}

function typeForValues(values: unknown[], effective: Set<string>): unknown {
  try {
    return inferTypeFromValues(values);
  } catch {
    // Mixed value types — fall back to the intersected schema types.
  }
  const types = [...effective];
  const [only] = types;
  return types.length === 1 && only !== undefined ? only : types;
}

function valueSatisfiesTypeSet(value: unknown, types: Set<string>): boolean {
  const valueType = inferValueType(value);
  if (valueType === undefined) return false;
  if (types.has(valueType)) return true;
  return valueType === 'integer' && types.has('number');
}

function intersectTypeSets(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const type of b) {
    if (a.has(type)) {
      result.add(type);
    } else if (
      (type === 'number' && a.has('integer')) ||
      (type === 'integer' && a.has('number'))
    ) {
      result.add('integer');
    }
  }
  return result;
}

function toTypeSet(value: unknown): Set<string> | undefined {
  if (typeof value === 'string') {
    return new Set([value]);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return new Set(value);
  }
  return undefined;
}

function hasUnresolvedDefinitionRef(node: unknown, bucketKey: string): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => hasUnresolvedDefinitionRef(child, bucketKey));
  }
  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string' && ref.startsWith(`#/${bucketKey}/`)) {
      return true;
    }
    for (const [key, value] of Object.entries(obj)) {
      // Skip the definition bucket itself when walking the result — we only
      // care about `$ref` pointers living elsewhere in the schema.
      if (key === bucketKey) continue;
      if (hasUnresolvedDefinitionRef(value, bucketKey)) return true;
    }
    return false;
  }
  return false;
}

function resolveNode(node: unknown, root: Record<string, unknown>, visited: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveNode(item, root, visited));
  }

  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;

    // Handle $ref
    if (typeof obj['$ref'] === 'string') {
      const ref = obj['$ref'];
      if (isLocalJsonPointerRef(ref)) {
        if (visited.has(ref)) {
          // Circular reference — return the $ref as-is to avoid infinite recursion
          return obj;
        }
        const resolvedRef = resolveLocalJsonPointer(root, ref);
        if (resolvedRef.found) {
          visited.add(ref);
          const resolved = resolveNode(resolvedRef.value, root, visited);
          visited.delete(ref);
          // Preserve sibling keywords (JSON Schema 2020-12 semantics):
          // a node may contain `$ref` alongside other fields like
          // `description`, `default`, or local constraints. Python's deref
          // implementation merges these with the resolved definition;
          // sibling keys on the local node take precedence.
          if (typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)) {
            const merged: Record<string, unknown> = { ...(resolved as Record<string, unknown>) };
            for (const [key, value] of Object.entries(obj)) {
              if (key === '$ref') continue;
              merged[key] = resolveNode(value, root, visited);
            }
            return merged;
          }
          return resolved;
        }
      }
      // Unknown $ref — return as-is
      return obj;
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveNode(value, root, visited);
    }
    return resolved;
  }

  return node;
}

function isLocalJsonPointerRef(ref: string): boolean {
  return ref === '#' || ref.startsWith('#/');
}

function resolveLocalJsonPointer(
  root: Record<string, unknown>,
  ref: string,
): { found: true; value: unknown } | { found: false } {
  if (ref === '#') {
    return { found: true, value: root };
  }
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = unescapeJsonPointerPart(rawPart);
    if (isRecord(current)) {
      if (!hasOwn(current, part)) {
        return { found: false };
      }
      current = current[part];
    } else if (Array.isArray(current)) {
      const index = parseJsonPointerArrayIndex(part);
      if (index === null || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function unescapeJsonPointerPart(part: string): string {
  return part.replaceAll('~1', '/').replaceAll('~0', '~');
}

function parseJsonPointerArrayIndex(part: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(part)) {
    return null;
  }
  return Number(part);
}

function recurseSchema(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }

  visitChildSchemas(node, normalizeProperty);
}

function visitChildSchemas(node: Record<string, unknown>, visit: (schema: unknown) => void): void {
  for (const { key, kind } of CHILD_SCHEMA_SLOTS) {
    const value = node[key];
    if (kind === 'single') {
      if (isRecord(value)) {
        visit(value);
      }
    } else if (kind === 'array') {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      }
    } else if (kind === 'map') {
      if (isRecord(value)) {
        for (const item of Object.values(value)) {
          visit(item);
        }
      }
    } else if (kind === 'schema-or-array') {
      if (isRecord(value)) {
        visit(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      }
    }
  }
}

function childSchemaKeysForParentType(parentType: StructuralJsonSchemaType): string[] {
  return CHILD_SCHEMA_SLOTS.flatMap((slot) => {
    if (!('parentType' in slot) || slot.parentType !== parentType) {
      return [];
    }
    return [slot.key];
  });
}

function normalizeProperty(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }

  if (!hasOwn(node, 'type') && !hasAnyKey(node, TYPE_COMPLETION_SKIP_KEYS)) {
    const enumValues = node['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      node['type'] = inferTypeFromValues(enumValues);
    } else if (hasOwn(node, 'const')) {
      node['type'] = inferTypeFromValues([node['const']]);
    } else {
      node['type'] = inferTypeFromStructure(node);
    }
  } else if (!hasAnyKey(node, TYPE_COMPLETION_SKIP_KEYS) && typeof node['type'] === 'string') {
    // Some MCP servers emit schemas where a $ref merge or a generator bug
    // leaves an explicit type that contradicts the enum/const values (e.g.
    // type: 'object' alongside string enum values). Moonshot rejects these
    // as invalid, so repair the type when it disagrees with the values.
    //
    // Known trigger: Xcode MCP (xcrun mcpbridge) starting with
    // Version 26.5 (17F42) generates this bug for String-backed Swift enums.
    const enumValues = node['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      try {
        const inferred = inferTypeFromValues(enumValues);
        if (node['type'] !== inferred) {
          node['type'] = inferred;
          removeIrrelevantStructureKeys(node, inferred);
        }
      } catch {
        // Mixed or uninferable enum types — leave the explicit type as-is
        // and let the provider validator surface the error.
      }
    } else if (hasOwn(node, 'const')) {
      try {
        const inferred = inferTypeFromValues([node['const']]);
        if (node['type'] !== inferred) {
          node['type'] = inferred;
          removeIrrelevantStructureKeys(node, inferred);
        }
      } catch {
        // Same as above.
      }
    }
  }

  recurseSchema(node);
}

function removeIrrelevantStructureKeys(
  node: Record<string, unknown>,
  newType: JsonSchemaType,
): void {
  if (newType !== 'object') {
    for (const key of OBJECT_STRUCTURE_KEYS) {
      delete node[key];
    }
  }
  if (newType !== 'array') {
    for (const key of ARRAY_STRUCTURE_KEYS) {
      delete node[key];
    }
  }
}

function inferTypeFromStructure(schema: Record<string, unknown>): JsonSchemaType {
  if (hasAnyKey(schema, OBJECT_STRUCTURE_KEYS)) {
    return 'object';
  }
  if (hasAnyKey(schema, ARRAY_STRUCTURE_KEYS)) {
    return 'array';
  }
  if (hasAnyKey(schema, STRING_STRUCTURE_KEYS)) {
    return 'string';
  }
  if (hasAnyKey(schema, NUMERIC_STRUCTURE_KEYS)) {
    return 'number';
  }
  return 'string';
}

function inferTypeFromValues(values: unknown[]): JsonSchemaType {
  const inferred = new Set<JsonSchemaType>();
  for (const value of values) {
    const valueType = inferValueType(value);
    if (valueType === undefined) {
      throw new Error('Cannot infer JSON Schema type from non-JSON enum or const value.');
    }
    inferred.add(valueType);
  }
  const types = normalizeInferredTypes(inferred);
  if (types.length === 1) {
    const onlyType = types[0];
    if (onlyType === undefined) {
      throw new Error('Cannot infer JSON Schema type from an empty enum.');
    }
    return onlyType;
  }
  throw new Error('Mixed JSON Schema enum or const types are not supported by Kimi tool schemas.');
}

function inferValueType(value: unknown): JsonSchemaType | undefined {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      return undefined;
  }
  return undefined;
}

function normalizeInferredTypes(types: Set<JsonSchemaType>): JsonSchemaType[] {
  const normalized = new Set(types);
  if (normalized.has('number')) {
    normalized.delete('integer');
  }
  const order: JsonSchemaType[] = [
    'string',
    'number',
    'integer',
    'boolean',
    'object',
    'array',
    'null',
  ];
  return order.filter((type) => normalized.has(type));
}

function hasAnyKey(obj: Record<string, unknown>, keys: Set<string>): boolean {
  for (const key of keys) {
    if (hasOwn(obj, key)) {
      return true;
    }
  }
  return false;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (isRecord(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(child);
    }
    return cloned;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
