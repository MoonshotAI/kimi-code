import { createHash } from 'node:crypto';

export type ContractDirection = 'input' | 'output';

export interface ContractType {
  readonly base: string;
  readonly values: readonly string[] | undefined;
  readonly nullable: boolean;
  readonly closed: boolean;
  readonly constraints: Readonly<Record<string, string>>;
  readonly defaultValue: string | undefined;
}

export const CONSTRAINT_KEYWORDS = [
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
] as const;

export interface ContractField extends ContractType {
  readonly key: string;
  readonly direction: ContractDirection;
  readonly required: boolean;
  readonly parentClosed: boolean;
}

export interface ContractSummary {
  readonly fields: ReadonlyMap<string, ContractField>;
  readonly lines: readonly string[];
}

type Schema = Readonly<Record<string, unknown>>;

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const SHARED_SHAPE_USES = 3;
const SHARED_SHAPE_PROPERTIES = 3;

interface Walk {
  readonly fields: Map<string, ContractField>;
  readonly lines: string[];
  readonly shapeUses: ReadonlyMap<string, number>;
  readonly shapes: Map<string, readonly string[]>;
}

export function summarizeContract(openapi: unknown, asyncapi: unknown): ContractSummary {
  const roots = [...openApiRoots(inlineSchemaRefs(asRecord(openapi))), ...asyncApiRoots(asRecord(asyncapi))];
  const shapeUses = new Map<string, number>();
  for (const root of roots) countShapes(root.schema, shapeUses);
  const walk: Walk = { fields: new Map(), lines: [], shapeUses, shapes: new Map() };
  for (const root of roots) {
    if (root.schema === undefined) {
      addField(walk, root.key, root.direction, { base: 'operation', values: undefined, nullable: false, closed: false, constraints: {}, defaultValue: undefined }, true, false, 'operation');
      continue;
    }
    visit(walk, root.schema, root.key, root.direction, root.required, false);
  }
  const shapeLines = [...walk.shapes].toSorted(([a], [b]) => a.localeCompare(b)).flatMap(([hash, lines]) => lines.map((line) => `shape ${hash}${line}`));
  return { fields: walk.fields, lines: [...walk.lines.toSorted(), ...shapeLines] };
}

interface Root {
  readonly key: string;
  readonly direction: ContractDirection;
  readonly required: boolean;
  readonly schema: Schema | undefined;
}

function openApiRoots(document: Schema): Root[] {
  const roots: Root[] = [];
  for (const [path, item] of Object.entries(asRecord(document['paths']))) {
    for (const [method, raw] of Object.entries(asRecord(item))) {
      if (!HTTP_METHODS.has(method)) continue;
      const operation = asRecord(raw);
      const prefix = `${method.toUpperCase()} ${path}`;
      roots.push({ key: prefix, direction: 'output', required: true, schema: undefined });
      const parameters = new Map<string, unknown>();
      for (const rawParameter of [...asArray(asRecord(item)['parameters']), ...asArray(operation['parameters'])]) {
        const parameter = asRecord(rawParameter);
        parameters.set(`${String(parameter['in'])}:${String(parameter['name'])}`, rawParameter);
      }
      for (const rawParameter of parameters.values()) {
        const parameter = asRecord(rawParameter);
        roots.push({
          key: `${prefix} param ${String(parameter['in'])}:${String(parameter['name'])}`,
          direction: 'input',
          required: parameter['required'] === true,
          schema: asRecord(parameter['schema']),
        });
      }
      const body = jsonSchemaOf(operation['requestBody']);
      if (body !== undefined) roots.push({ key: `${prefix} request`, direction: 'input', required: asRecord(operation['requestBody'])['required'] === true, schema: body });
      for (const [status, response] of Object.entries(asRecord(operation['responses']))) {
        roots.push({ key: `${prefix} response ${status}`, direction: 'output', required: true, schema: jsonSchemaOf(response) ?? {} });
      }
    }
  }
  return roots;
}

function asyncApiRoots(document: Schema): Root[] {
  const directionOf = new Map<string, ContractDirection>();
  for (const operation of Object.values(asRecord(document['operations']))) {
    const { action, messages } = asRecord(operation);
    for (const message of asArray(messages)) {
      const reference = asRecord(message)['$ref'];
      const name = typeof reference === 'string' ? (reference.split('/').at(-1) ?? '') : '';
      directionOf.set(name, action === 'receive' ? 'input' : 'output');
    }
  }
  return Object.entries(asRecord(asRecord(document['components'])['messages'])).map(([name, message]) => {
    const direction = directionOf.get(name) ?? 'output';
    return { key: `ws ${direction === 'input' ? 'client' : 'server'} message ${name}`, direction, required: true, schema: asRecord(asRecord(message)['payload']) };
  });
}

function jsonSchemaOf(holder: unknown): Schema | undefined {
  const content = asRecord(asRecord(holder)['content']);
  const json = content['application/json'] ?? Object.values(content)[0];
  return json === undefined ? undefined : asRecord(asRecord(json)['schema']);
}

function visit(walk: Walk, schema: Schema, key: string, direction: ContractDirection, required: boolean, parentClosed: boolean): void {
  const type = typeOf(schema);
  const shape = sharedShape(walk, schema);
  addField(walk, key, direction, type, required, parentClosed, shape === undefined ? displayType(type) : `shape ${shape}`);
  if (shape === undefined) {
    expandChildren(walk, schema, key, direction);
    return;
  }
  if (!walk.shapes.has(shape)) {
    const body: Walk = { ...walk, fields: new Map(), lines: [] };
    walk.shapes.set(shape, []);
    expandChildren(body, schema, '', direction);
    walk.shapes.set(shape, body.lines.toSorted());
  }
  expandChildren({ ...walk, lines: [] }, schema, key, direction);
}

function expandChildren(walk: Walk, schema: Schema, key: string, direction: ContractDirection): void {
  const closed = schema['additionalProperties'] === false;
  const required = new Set(asArray(schema['required']).map(String));
  for (const [name, child] of Object.entries(asRecord(schema['properties']))) {
    visit(walk, asRecord(child), `${key}.${name}`, direction, required.has(name), closed);
  }
  if (schema['items'] !== undefined && typeof schema['items'] === 'object') visit(walk, asRecord(schema['items']), `${key}[]`, direction, true, false);
  const additional = schema['additionalProperties'];
  if (additional !== undefined && typeof additional === 'object' && additional !== null) visit(walk, asRecord(additional), `${key}{*}`, direction, false, false);
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    const variants = asArray(schema[keyword]).map(asRecord);
    const names = variants.map((variant, index) => variantName(variant, index));
    variants.forEach((variant, index) => {
      const name = names.indexOf(names[index]!) === index && names.lastIndexOf(names[index]!) === index ? names[index]! : `${names[index]!}#${index}`;
      visit(walk, variant, `${key}<${name}>`, direction, true, false);
    });
  }
}

function addField(walk: Walk, key: string, direction: ContractDirection, type: ContractType, required: boolean, parentClosed: boolean, shown: string): void {
  walk.fields.set(key, { key, direction, ...type, required, parentClosed });
  walk.lines.push(`${key}: ${shown}${required ? '' : ' optional'}`);
}

function variantName(schema: Schema, index: number): string {
  const properties = asRecord(schema['properties']);
  const discriminator = asRecord(properties['type'])['const'] ?? asArray(asRecord(properties['type'])['enum'])[0];
  if (typeof discriminator === 'string') return discriminator;
  const code = asArray(asRecord(properties['code'])['enum'])[0];
  if (code !== undefined) return `code=${JSON.stringify(code)}`;
  return `#${index}`;
}

function typeOf(schema: Schema): ContractType {
  const union = ['oneOf', 'anyOf', 'allOf'].find((keyword) => schema[keyword] !== undefined);
  let base: string;
  let values: readonly string[] | undefined;
  if (schema['const'] !== undefined) {
    base = 'const';
    values = [JSON.stringify(schema['const'])];
  } else if (Array.isArray(schema['enum'])) {
    base = 'enum';
    values = schema['enum'].map((value) => JSON.stringify(value)).toSorted();
  } else if (schema['type'] !== undefined) {
    const types = typeof schema['type'] === 'string' ? [schema['type']] : asArray(schema['type']).filter((type): type is string => typeof type === 'string');
    base = types.toSorted().join('|') || 'any';
  } else if (schema['properties'] !== undefined) {
    base = 'object';
  } else {
    base = union ?? 'any';
  }
  if (typeof schema['format'] === 'string') base = `${base} format ${schema['format']}`;
  const constraints: Record<string, string> = {};
  for (const keyword of CONSTRAINT_KEYWORDS) {
    if (schema[keyword] !== undefined) constraints[keyword] = JSON.stringify(schema[keyword]);
  }
  const defaultValue = schema['default'] === undefined ? undefined : JSON.stringify(schema['default']);
  return { base, values, nullable: schema['nullable'] === true, closed: schema['additionalProperties'] === false, constraints, defaultValue };
}

export function displayType(type: ContractType): string {
  const constraints = Object.entries(type.constraints).map(([keyword, value]) => `${keyword}=${value}`);
  const defaultValue = type.defaultValue === undefined ? undefined : `default=${type.defaultValue}`;
  return [type.base, type.values?.join('|'), ...constraints, defaultValue, type.nullable ? 'nullable' : undefined, type.closed ? 'closed' : undefined]
    .filter((part) => part !== undefined)
    .join(' ');
}

function sharedShape(walk: Walk, schema: Schema): string | undefined {
  const hash = shapeHash(schema);
  return hash !== undefined && (walk.shapeUses.get(hash) ?? 0) >= SHARED_SHAPE_USES ? hash : undefined;
}

function countShapes(schema: Schema | undefined, uses: Map<string, number>): void {
  if (schema === undefined) return;
  const hash = shapeHash(schema);
  if (hash !== undefined) uses.set(hash, (uses.get(hash) ?? 0) + 1);
  for (const child of Object.values(asRecord(schema['properties']))) countShapes(asRecord(child), uses);
  if (typeof schema['items'] === 'object' && schema['items'] !== null) countShapes(asRecord(schema['items']), uses);
  if (typeof schema['additionalProperties'] === 'object' && schema['additionalProperties'] !== null) countShapes(asRecord(schema['additionalProperties']), uses);
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) for (const variant of asArray(schema[keyword])) countShapes(asRecord(variant), uses);
}

function shapeHash(schema: Schema): string | undefined {
  if (Object.keys(asRecord(schema['properties'])).length < SHARED_SHAPE_PROPERTIES) return undefined;
  return createHash('sha256').update(canonical(schema)).digest('hex').slice(0, 8);
}

const ANNOTATION_KEYWORDS = new Set(['description', 'summary', 'example', 'examples', 'title']);
const MEMBER_NAME_KEYWORDS = new Set(['properties', 'patternProperties']);

export function canonical(value: unknown, memberNames = false): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const entries = Object.entries(value)
    .filter(([key, item]) => item !== undefined && (memberNames || !ANNOTATION_KEYWORDS.has(key)))
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, !memberNames && MEMBER_NAME_KEYWORDS.has(key))}`);
  return `{${entries.join(',')}}`;
}

export function contractDigest(openapi: unknown, asyncapi: unknown): string {
  const rest = inlineSchemaRefs(asRecord(openapi));
  const ws = asRecord(asyncapi);
  const contract = { paths: rest['paths'], components: rest['components'], operations: ws['operations'], messages: ws['components'] };
  return createHash('sha256').update(canonical(contract)).digest('hex');
}

const SCHEMA_REF_PREFIX = '#/components/schemas/';

export function inlineSchemaRefs(document: Schema): Schema {
  const components = asRecord(document['components']);
  const schemas = asRecord(components['schemas']);
  if (Object.keys(schemas).length === 0) return document;
  const inlined = new Set<string>();
  const inline = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(inline);
    if (typeof value !== 'object' || value === null) return value;
    const reference = (value as Schema)['$ref'];
    if (typeof reference === 'string' && reference.startsWith(SCHEMA_REF_PREFIX)) {
      const name = reference.slice(SCHEMA_REF_PREFIX.length);
      if (schemas[name] !== undefined) {
        inlined.add(name);
        return inline(schemas[name]);
      }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inline(item)]));
  };
  const paths = inline(document['paths']);
  const rest = Object.fromEntries(Object.entries(schemas).filter(([name]) => !inlined.has(name)));
  return { ...document, paths, components: { ...components, schemas: rest } };
}

function asRecord(value: unknown): Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Schema) : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
