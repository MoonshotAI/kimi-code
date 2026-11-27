import { createHash } from 'node:crypto';

import { z } from 'zod';

import { buildErrorEnvelopeSchema } from '../middleware/defineRoute';
import { openApiDocumentJsonSchema } from '../middleware/schema';
import { ErrorCode } from '../protocol/error-codes';
import { messageContentSchema } from '../protocol/message';
import { sessionSchema } from '../protocol/session';
import { sessionWorktreeSchema, worktreeHeldPromptSchema, worktreeSetupSchema } from '../protocol/worktree';

const SCHEMA_REF_PREFIX = '#/components/schemas/';
const MIN_SHARED_WEIGHT = 10;
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

type JsonObject = Record<string, unknown>;

interface Shape {
  readonly key: string;
  readonly weight: number;
}

interface Occurrence {
  count: number;
  readonly weight: number;
}

const namedSchemas: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['Session', sessionSchema],
  ['SessionWorktree', sessionWorktreeSchema],
  ['WorktreeSetup', worktreeSetupSchema],
  ['WorktreeHeldPrompt', worktreeHeldPromptSchema],
  ['MessageContent', messageContentSchema],
  [
    'ErrorValidationFailedWithDetails',
    buildErrorEnvelopeSchema(ErrorCode.VALIDATION_FAILED, z.null(), z.array(z.object({ path: z.string(), message: z.string() }))),
  ],
  ...Object.entries(ErrorCode)
    .filter(([, code]) => code !== ErrorCode.SUCCESS)
    .map(([name, code]) => [`Error${pascalCase(name)}`, buildErrorEnvelopeSchema(code)] as const),
];

export function shareSchemas(document: JsonObject): void {
  const nameByKey = new Map<string, string>();
  const namedBodies = new Map<string, JsonObject>();
  for (const [name, schema] of namedSchemas) {
    for (const [suffix, io] of [['', 'output'], ['Input', 'input']] as const) {
      const body = openApiDocumentJsonSchema(schema, io);
      const key = shapeOf(body, new Map()).key;
      if (nameByKey.has(key)) continue;
      nameByKey.set(key, `${name}${suffix}`);
      namedBodies.set(`${name}${suffix}`, body);
    }
  }

  const components = new Map<string, JsonObject>();
  const takenNames = new Set(namedBodies.keys());
  let paths = asObject(document['paths']);

  for (;;) {
    const shapes = new Map<JsonObject, Shape>();
    const occurrences = new Map<string, Occurrence>();
    const count = (schema: JsonObject): void => {
      const shape = shapeOf(schema, shapes);
      const seen = occurrences.get(shape.key);
      if (seen === undefined) occurrences.set(shape.key, { count: 1, weight: shape.weight });
      else seen.count += 1;
    };
    forEachRoot(paths, components, (schema, context) => visitSchemas(schema, context, count));

    const newNames = new Map<string, string>();
    const select = (schema: JsonObject, context: readonly string[]): void => {
      const key = shapeOf(schema, shapes).key;
      if (nameByKey.has(key) || newNames.has(key)) return;
      const occurrence = occurrences.get(key);
      if (occurrence !== undefined && occurrence.count >= 2 && occurrence.weight >= MIN_SHARED_WEIGHT) {
        const name = uniqueName(schemaName(context), takenNames);
        takenNames.add(name);
        newNames.set(key, name);
        return;
      }
      mapSubschemas(schema, context, (child, childContext) => {
        select(child, childContext);
        return child;
      });
    };
    forEachRoot(paths, components, select);

    let added = false;
    const share = (schema: JsonObject, context: readonly string[], isRoot: boolean): JsonObject => {
      if (!isRoot) {
        const key = shapeOf(schema, shapes).key;
        const name = nameByKey.get(key) ?? newNames.get(key);
        if (name !== undefined) {
          if (!components.has(name)) {
            components.set(name, namedBodies.get(name) ?? schema);
            nameByKey.set(key, name);
            added = true;
          }
          return { $ref: `${SCHEMA_REF_PREFIX}${name}` };
        }
      }
      return mapSubschemas(schema, context, (child, childContext) => share(child, childContext, false));
    };
    paths = mapOperationSchemas(paths, (schema, context) => share(schema, context, false));
    for (const [name, body] of components) {
      components.set(name, share(body, [name], true));
    }
    if (!added) break;
  }

  document['paths'] = paths;
  const existing = asObject(asObject(document['components'])['schemas']);
  const shared = Object.fromEntries([...components].toSorted(([a], [b]) => a.localeCompare(b)));
  document['components'] = { ...asObject(document['components']), schemas: { ...existing, ...shared } };
}

function forEachRoot(
  paths: JsonObject,
  components: ReadonlyMap<string, JsonObject>,
  visit: (schema: JsonObject, context: readonly string[]) => void,
): void {
  mapOperationSchemas(paths, (schema, context) => {
    visit(schema, context);
    return schema;
  });
  for (const [name, body] of components) {
    mapSubschemas(body, [name], (child, context) => {
      visit(child, context);
      return child;
    });
  }
}

function visitSchemas(
  schema: JsonObject,
  context: readonly string[],
  visit: (schema: JsonObject, context: readonly string[]) => void,
): void {
  visit(schema, context);
  mapSubschemas(schema, context, (child, childContext) => {
    visitSchemas(child, childContext, visit);
    return child;
  });
}

function mapOperationSchemas(
  paths: JsonObject,
  map: (schema: JsonObject, context: readonly string[]) => JsonObject,
): JsonObject {
  return mapEntries(paths, (path, item) =>
    mapEntries(asObject(item), (method, operation) => {
      if (!HTTP_METHODS.has(method) || !isObject(operation)) return operation;
      const prefix = operationName(method, path);
      return mapSchemaHolders(operation, [prefix], map);
    }),
  );
}

function mapSchemaHolders(
  value: unknown,
  context: readonly string[],
  map: (schema: JsonObject, context: readonly string[]) => JsonObject,
): unknown {
  if (Array.isArray(value)) return value.map((item) => mapSchemaHolders(item, context, map));
  if (!isObject(value)) return value;
  const here = typeof value['name'] === 'string' && value['in'] !== undefined ? [...context, value['name']] : context;
  return mapEntries(value, (key, child) => {
    if (key === 'schema' && isObject(child)) return map(child, here);
    return mapSchemaHolders(child, [...here, ...holderToken(key)], map);
  });
}

function holderToken(key: string): string[] {
  if (key === 'requestBody') return ['Request'];
  if (key === 'responses') return ['Response'];
  if (key === 'parameters') return ['Param'];
  if (key === 'headers') return ['Header'];
  return [];
}

function mapSubschemas(
  schema: JsonObject,
  context: readonly string[],
  map: (schema: JsonObject, context: readonly string[]) => JsonObject,
): JsonObject {
  return mapEntries(schema, (key, value) => {
    if ((key === 'properties' || key === 'patternProperties') && isObject(value)) {
      return mapEntries(value, (name, child) => (isObject(child) ? map(child, propertyContext(context, name)) : child));
    }
    if (key === 'items' && isObject(value)) return map(value, itemContext(context));
    if (key === 'additionalProperties' && isObject(value)) return map(value, [...context, 'Value']);
    if (key === 'not' && isObject(value)) return map(value, [...context, 'Not']);
    const variants = key === 'oneOf' || key === 'anyOf' || key === 'allOf' ? asArray(value) : undefined;
    if (variants !== undefined) {
      return variants.map((child) => (isObject(child) ? map(child, [...context, ...variantToken(child)]) : child));
    }
    return value;
  });
}

function propertyContext(context: readonly string[], name: string): readonly string[] {
  const last = context.at(-1);
  if (name === 'data' && (last === 'Response' || last === 'Ok')) return context;
  return [...context, name];
}

function itemContext(context: readonly string[]): readonly string[] {
  const last = context.at(-1);
  if (last === undefined || !/[a-z]s$/.test(last) || last.endsWith('ss')) return [...context, 'Item'];
  const singular = last.endsWith('ies') ? `${last.slice(0, -3)}y` : last.slice(0, -1);
  return [...context.slice(0, -1), singular];
}

function variantToken(variant: JsonObject): string[] {
  const properties = asObject(variant['properties']);
  const type = asObject(properties['type']);
  const values = asArray(type['enum']);
  const discriminator = type['const'] ?? (values?.length === 1 ? values[0] : undefined);
  if (typeof discriminator === 'string') return [discriminator];
  const codes = asArray(asObject(properties['code'])['enum']);
  if (codes?.length === 1 && codes[0] === 0) return ['Ok'];
  return [];
}

function shapeOf(value: unknown, memo: Map<JsonObject, Shape>): Shape {
  if (Array.isArray(value)) {
    const items = value.map((item) => shapeOf(item, memo));
    return { key: digest(`[${items.map((item) => item.key).join(',')}]`), weight: 2 + sum(items) };
  }
  if (!isObject(value)) return { key: JSON.stringify(value) ?? 'undefined', weight: 1 };
  const cached = memo.get(value);
  if (cached !== undefined) return cached;
  const entries = Object.keys(value)
    .toSorted()
    .map((key) => [key, shapeOf(value[key], memo)] as const);
  const shape = {
    key: digest(`{${entries.map(([key, child]) => `${JSON.stringify(key)}:${child.key}`).join(',')}}`),
    weight: 2 + sum(entries.map(([, child]) => child)),
  };
  memo.set(value, shape);
  return shape;
}

function digest(text: string): string {
  return createHash('sha1').update(text).digest('base64');
}

function sum(shapes: readonly Shape[]): number {
  return shapes.reduce((total, shape) => total + shape.weight, 0);
}

function schemaName(context: readonly string[]): string {
  return context.map(pascalCase).join('');
}

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    if (!taken.has(`${base}${index}`)) return `${base}${index}`;
  }
}

function operationName(method: string, path: string): string {
  const segments = path
    .replace(/^\/api\/v1\//, '')
    .split(/[/:]/)
    .filter((segment) => segment.length > 0 && !segment.startsWith('{') && segment !== '*');
  return [method, ...segments].map(pascalCase).join('');
}

function mapEntries(value: JsonObject, map: (key: string, value: unknown) => unknown): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, map(key, child)]));
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => (part === part.toUpperCase() ? part.charAt(0) + part.slice(1).toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}
