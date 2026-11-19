import {
  BROWSER_OPERATIONS,
  BROWSER_OPERATION_PARAMETERS,
  BROWSER_RUN_INPUT_SCHEMA,
  type BrowserOperation,
} from '../../shared/browser-automation';

type SchemaNode = Record<string, unknown>;

export interface BrowserRunToolSchema {
  type: 'object';
  properties: Record<string, SchemaNode>;
  required: string[];
  additionalProperties: false;
}

const MIN_KEYWORDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'] as const;
const MAX_KEYWORDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'] as const;
const SHARED_KEYWORDS = ['pattern', 'format'] as const;

function asNode(value: unknown): SchemaNode {
  return value as SchemaNode;
}

function properties(node: SchemaNode): Record<string, SchemaNode> {
  return (node['properties'] ?? {}) as Record<string, SchemaNode>;
}

function required(node: SchemaNode): string[] {
  return (node['required'] ?? []) as string[];
}

function describedBy(nodes: SchemaNode[]): string | undefined {
  const texts = [...new Set(nodes.map(node => node['description']).filter((text): text is string => typeof text === 'string' && text.length > 0))];
  return texts.length > 0 ? texts.join(' ') : undefined;
}

function enumType(values: readonly unknown[]): string | undefined {
  if (values.every(value => typeof value === 'string')) return 'string';
  if (values.every(value => typeof value === 'boolean')) return 'boolean';
  if (values.every(value => typeof value === 'number')) return values.every(value => Number.isInteger(value)) ? 'integer' : 'number';
  return undefined;
}

function mergeNumericKeywords(nodes: SchemaNode[], target: SchemaNode): void {
  for (const keyword of MIN_KEYWORDS) {
    const values = nodes.map(node => node[keyword]);
    if (values.every((value): value is number => typeof value === 'number')) target[keyword] = Math.min(...values);
  }
  for (const keyword of MAX_KEYWORDS) {
    const values = nodes.map(node => node[keyword]);
    if (values.every((value): value is number => typeof value === 'number')) target[keyword] = Math.max(...values);
  }
  for (const keyword of SHARED_KEYWORDS) {
    const values = new Set(nodes.map(node => node[keyword]));
    const [value] = [...values];
    if (values.size === 1 && value !== undefined) target[keyword] = value;
  }
}

function mergeObjects(nodes: SchemaNode[]): SchemaNode {
  const merged: Record<string, SchemaNode> = {};
  for (const key of new Set(nodes.flatMap(node => Object.keys(properties(node))))) {
    const candidates = nodes.map(node => properties(node)[key]).filter((node): node is SchemaNode => node !== undefined);
    merged[key] = merge(candidates);
  }
  const shared = required(nodes[0]!).filter(key => merged[key] !== undefined && nodes.every(node => required(node).includes(key)));
  const description = describedBy(nodes);
  return {
    type: 'object',
    ...(description === undefined ? {} : { description }),
    ...(shared.length > 0 ? { required: shared } : {}),
    properties: merged,
    ...(nodes.every(node => node['additionalProperties'] === false) ? { additionalProperties: false } : {}),
  };
}

function mergeScalars(nodes: SchemaNode[]): SchemaNode {
  const description = describedBy(nodes);
  const merged: SchemaNode = description === undefined ? {} : { description };
  const types = new Set(nodes.map(node => node['type']));
  const [type] = [...types];
  if (types.size !== 1 || typeof type !== 'string') return merged;
  merged['type'] = type;
  if (type !== 'boolean' && nodes.every(node => Array.isArray(node['enum']))) {
    merged['enum'] = [...new Set(nodes.flatMap(node => node['enum'] as unknown[]))];
    return merged;
  }
  mergeNumericKeywords(nodes, merged);
  const items = nodes.map(node => node['items']).filter((node): node is SchemaNode => node !== undefined);
  if (items.length === nodes.length) merged['items'] = merge(items);
  return merged;
}

function merge(nodes: SchemaNode[]): SchemaNode {
  if (nodes.length === 1) return nodes[0]!;
  return nodes.every(node => node['type'] === 'object') ? mergeObjects(nodes) : mergeScalars(nodes);
}

function flatten(node: SchemaNode): SchemaNode | null {
  if (node['not'] !== undefined) return null;
  const union = node['anyOf'] ?? node['oneOf'] ?? node['allOf'];
  if (Array.isArray(union)) {
    const branches = union.map(branch => flatten(asNode(branch))).filter((branch): branch is SchemaNode => branch !== null);
    if (branches.length === 0) return null;
    const merged = merge(branches);
    const description = node['description'];
    return typeof description === 'string' ? { ...merged, description } : merged;
  }
  if (node['type'] === 'object') {
    const merged: Record<string, SchemaNode> = {};
    for (const [key, value] of Object.entries(properties(node))) {
      const property = flatten(value);
      if (property !== null) merged[key] = property;
    }
    const kept = required(node).filter(key => merged[key] !== undefined);
    return {
      ...node,
      ...(kept.length > 0 ? { required: kept } : {}),
      properties: merged,
    };
  }
  const flat = { ...node };
  if ('const' in flat) {
    flat['enum'] = [flat['const']];
    delete flat['const'];
  }
  if (flat['items'] !== undefined) {
    const items = flatten(asNode(flat['items']));
    if (items === null) return null;
    flat['items'] = items;
  }
  const values = flat['enum'];
  if (Array.isArray(values) && typeof flat['type'] !== 'string') {
    const type = enumType(values);
    if (type === undefined) delete flat['enum'];
    else flat['type'] = type;
  }
  return flat;
}

function operationsUsing(field: string): { requiredIn: BrowserOperation[]; choiceIn: BrowserOperation[]; optionalIn: BrowserOperation[] } {
  const requiredIn: BrowserOperation[] = [];
  const choiceIn: BrowserOperation[] = [];
  const optionalIn: BrowserOperation[] = [];
  for (const operation of BROWSER_OPERATIONS) {
    const { required: mandatory, optional, alternatives } = BROWSER_OPERATION_PARAMETERS[operation];
    const exclusive = alternatives.length > 1 && alternatives.every(fields => fields.length > 0);
    if (mandatory.includes(field)) requiredIn.push(operation);
    else if (exclusive && alternatives.some(fields => fields.includes(field))) choiceIn.push(operation);
    else if (optional.includes(field)) optionalIn.push(operation);
  }
  return { requiredIn, choiceIn, optionalIn };
}

function describeUsage(field: string): string {
  const { requiredIn, choiceIn, optionalIn } = operationsUsing(field);
  const sentences: string[] = [];
  if (requiredIn.length > BROWSER_OPERATIONS.length / 2) {
    sentences.push(`Required for every operation except ${BROWSER_OPERATIONS.filter(operation => !requiredIn.includes(operation)).join(', ')}.`);
  } else if (requiredIn.length > 0) {
    sentences.push(`Required for ${requiredIn.join(', ')}.`);
  }
  for (const operation of choiceIn) {
    sentences.push(`Supply exactly one of ${[...new Set(BROWSER_OPERATION_PARAMETERS[operation].alternatives.flat())].join(', ')} for ${operation}.`);
  }
  if (optionalIn.length > 0) sentences.push(`Optional for ${optionalIn.join(', ')}.`);
  return sentences.join(' ');
}

function rangeLabel(node: SchemaNode): string | undefined {
  const minimum = node['minimum'] ?? node['exclusiveMinimum'];
  const maximum = node['maximum'] ?? node['exclusiveMaximum'];
  if (typeof minimum !== 'number' && typeof maximum !== 'number') return undefined;
  return `${typeof minimum === 'number' ? minimum : ''}–${typeof maximum === 'number' ? maximum : ''}`;
}

function describeRanges(branches: SchemaNode[], field: string): string | undefined {
  const ranges = new Map<string, string[]>();
  for (const branch of branches) {
    const property = properties(branch)[field];
    const flat = property === undefined ? null : flatten(property);
    const operation = properties(branch)['operation']?.['const'];
    const label = flat === null ? undefined : rangeLabel(flat);
    if (label === undefined || typeof operation !== 'string') continue;
    const operations = ranges.get(label) ?? [];
    if (!operations.includes(operation)) operations.push(operation);
    ranges.set(label, operations);
  }
  if (ranges.size < 2) return undefined;
  return `Range depends on the operation: ${[...ranges].map(([label, operations]) => `${label} for ${operations.join(', ')}`).join('; ')}.`;
}

function buildBrowserRunToolSchema(): BrowserRunToolSchema {
  const source = JSON.parse(JSON.stringify(BROWSER_RUN_INPUT_SCHEMA)) as SchemaNode;
  const branches = (source['anyOf'] ?? []) as SchemaNode[];
  const flat = flatten(source);
  if (flat === null) throw new Error('browser run schema flattened to nothing');
  const fields = properties(flat);
  for (const [field, node] of Object.entries(fields)) {
    if (field === 'protocol' || field === 'operation') continue;
    const notes = [
      node['description'],
      describeRanges(branches, field),
      describeUsage(field),
    ].filter((note): note is string => typeof note === 'string' && note.length > 0);
    node['description'] = notes.join(' ');
  }
  return {
    type: 'object',
    properties: fields,
    required: required(flat),
    additionalProperties: false,
  };
}

export const BROWSER_RUN_TOOL_SCHEMA = buildBrowserRunToolSchema();
