import { createHash } from 'node:crypto';

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import { KapSchemaError, TestkitError } from '#/errors';
import type { KapClient } from '#/kap/client';
import type { KapFrame } from '#/kap/frames';
import type { KapExchange } from '#/kap/rest';

type Schema = Readonly<Record<string, unknown>>;

interface Route {
  readonly template: string;
  readonly pattern: RegExp;
  readonly literalLength: number;
  readonly operations: Readonly<Record<string, unknown>>;
}

interface Problem {
  readonly problem: string;
  readonly example?: unknown;
}

interface Finding {
  readonly line: string;
  count: number;
}

const API_PREFIX = '/api/';
const OPENAPI_PATH = '/openapi.json';
const ASYNCAPI_PATH = '/asyncapi.json';
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const MAX_FINDINGS = 40;
const EXCERPT_LENGTH = 300;

const contracts = new Map<string, KapContract>();

export async function verifyKapSchemas(kap: KapClient): Promise<void> {
  const contract = await contractOf(kap);
  const problems: Problem[] = [];
  for (const exchange of await kap.restExchanges()) problems.push(...contract.exchangeProblems(exchange));
  kap.connectedSockets.forEach((socket, index) => {
    for (const text of socket.unreadableFrames) problems.push({ problem: `client #${index + 1} received a WebSocket frame that is not a JSON object with a string type`, example: text });
    for (const frame of socket.frames) problems.push(...contract.frameProblems(frame));
  });
  const findings = new Map<string, Finding>();
  for (const { problem, example } of problems) {
    const finding = findings.get(problem);
    if (finding === undefined) findings.set(problem, { line: example === undefined ? problem : `${problem}; first offending value: ${excerpt(example)}`, count: 1 });
    else finding.count += 1;
  }
  if (findings.size === 0) return;
  const lines = [...findings.values()].map(({ line, count }) => (count === 1 ? line : `${line} (${count} times)`));
  throw new KapSchemaError(lines.length > MAX_FINDINGS ? [...lines.slice(0, MAX_FINDINGS), `…and ${lines.length - MAX_FINDINGS} more`] : lines);
}

async function contractOf(kap: KapClient): Promise<KapContract> {
  const [openapi, asyncapi] = await Promise.all([documentText(kap, OPENAPI_PATH), documentText(kap, ASYNCAPI_PATH)]);
  const key = createHash('sha256').update(openapi).update('\0').update(asyncapi).digest('hex');
  let contract = contracts.get(key);
  if (contract === undefined) {
    contract = new KapContract(asRecord(JSON.parse(openapi)), asRecord(JSON.parse(asyncapi)));
    contracts.set(key, contract);
  }
  return contract;
}

async function documentText(kap: KapClient, path: string): Promise<string> {
  const response = await kap.rest.raw(path);
  const text = await response.text();
  if (!response.ok) throw new TestkitError(`Could not read the published KAP contract at ${path}: HTTP ${response.status} ${excerpt(text)}`);
  return text;
}

class KapContract {
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  private readonly routes: readonly Route[];
  private readonly frameSchemas: ReadonlyMap<string, readonly Schema[]>;

  constructor(openapi: Schema, asyncapi: Schema) {
    addFormats(this.ajv);
    toDraft7(openapi);
    this.routes = routesOf(openapi);
    this.frameSchemas = frameSchemasOf(asyncapi);
  }

  exchangeProblems(exchange: KapExchange): readonly Problem[] {
    if (!exchange.path.startsWith(API_PREFIX) || !exchange.json || exchange.body === undefined || exchange.body === '') return [];
    const method = exchange.method.toLowerCase();
    const request = `${exchange.method.toUpperCase()} ${exchange.path}`;
    const route = this.routes.find((candidate) => candidate.pattern.test(exchange.path) && candidate.operations[method] !== undefined);
    if (route === undefined) return [{ problem: `${request} answered, but ${OPENAPI_PATH} declares no such route` }];
    const where = `${exchange.method.toUpperCase()} ${route.template} → HTTP ${exchange.status}`;
    const responses = asRecord(asRecord(route.operations[method])['responses']);
    const response = responses[String(exchange.status)] ?? responses['default'];
    if (response === undefined) return [{ problem: `${where}: ${OPENAPI_PATH} declares only HTTP ${Object.keys(responses).join(', ')} for this route`, example: exchange.body }];
    const schema = jsonSchemaOf(response);
    if (schema === undefined) return [{ problem: `${where}: the server answered with JSON, but ${OPENAPI_PATH} declares no JSON body for this response`, example: exchange.body }];
    let body: unknown;
    try {
      body = JSON.parse(exchange.body);
    } catch {
      return [{ problem: `${where}: the body is labelled JSON but does not parse`, example: exchange.body }];
    }
    return this.problems(where, schema, body);
  }

  frameProblems(frame: KapFrame): readonly Problem[] {
    const schemas = this.frameSchemas.get(frame.type);
    if (schemas === undefined) return [{ problem: `WebSocket frame type ${JSON.stringify(frame.type)} is not a server message in ${ASYNCAPI_PATH}`, example: frame }];
    const attempts = schemas.map((schema) => this.problems(`WebSocket ${frame.type} frame`, schema, frame));
    if (attempts.some((problems) => problems.length === 0)) return [];
    return attempts.reduce((fewest, problems) => (problems.length < fewest.length ? problems : fewest));
  }

  private problems(where: string, schema: Schema, value: unknown): readonly Problem[] {
    const validate: ValidateFunction = this.ajv.compile(schema);
    if (validate(value)) return [];
    return narrowUnions(validate.errors ?? []).map((error) => ({ problem: `${where}: ${describeError(error)}`, example: valueAt(value, error.instancePath) ?? null }));
  }
}

function routesOf(openapi: Schema): Route[] {
  return Object.entries(asRecord(openapi['paths']))
    .map(([template, item]) => {
      const operations = Object.fromEntries(Object.entries(asRecord(item)).filter(([method]) => HTTP_METHODS.has(method)));
      const parts = template.split(/(\{[^}]*\})/);
      const source = parts.map((part) => (part === '{*}' ? '.+' : /^\{[^}]*\}$/.test(part) ? '[^/]+' : escapeRegExp(part))).join('');
      const literalLength = parts.filter((part) => !part.startsWith('{')).join('').length;
      return { template, pattern: new RegExp(`^${source}$`), literalLength, operations };
    })
    .toSorted((a, b) => b.literalLength - a.literalLength);
}

function frameSchemasOf(asyncapi: Schema): Map<string, Schema[]> {
  const messages = asRecord(asRecord(asyncapi['components'])['messages']);
  const byType = new Map<string, Schema[]>();
  for (const operation of Object.values(asRecord(asyncapi['operations']))) {
    if (asRecord(operation)['action'] !== 'send') continue;
    for (const reference of asArray(asRecord(operation)['messages'])) {
      const name = String(asRecord(reference)['$ref']).split('/').at(-1) ?? '';
      const payload = asRecord(asRecord(messages[name])['payload']);
      for (const type of new Set(typesOf(payload))) byType.set(type, [...(byType.get(type) ?? []), payload]);
    }
  }
  return byType;
}

function typesOf(schema: Schema): string[] {
  const variants = [...asArray(schema['oneOf']), ...asArray(schema['anyOf'])].map(asRecord);
  if (variants.length > 0) return variants.flatMap(typesOf);
  const type = asRecord(asRecord(schema['properties'])['type']);
  return [type['const'], ...asArray(type['enum'])].filter((value): value is string => typeof value === 'string');
}

function jsonSchemaOf(response: unknown): Schema | undefined {
  const content = asRecord(asRecord(response)['content']);
  const json = Object.entries(content).find(([mediaType]) => /\bjson\b/i.test(mediaType))?.[1];
  return json === undefined ? undefined : asRecord(asRecord(json)['schema']);
}

function toDraft7(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) toDraft7(child);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const schema = node as Record<string, unknown>;
  for (const [bound, exclusive] of [['minimum', 'exclusiveMinimum'], ['maximum', 'exclusiveMaximum']] as const) {
    const flag = schema[exclusive];
    if (typeof flag !== 'boolean') continue;
    if (flag && typeof schema[bound] === 'number') {
      schema[exclusive] = schema[bound];
      delete schema[bound];
    } else {
      delete schema[exclusive];
    }
  }
  for (const child of Object.values(schema)) toDraft7(child);
}

function narrowUnions(errors: readonly ErrorObject[]): ErrorObject[] {
  let kept = [...errors];
  const unions = errors.filter((error) => error.keyword === 'anyOf' || error.keyword === 'oneOf').toSorted((a, b) => a.schemaPath.length - b.schemaPath.length);
  for (const union of unions) {
    if (!kept.includes(union)) continue;
    const prefix = `${union.schemaPath}/`;
    const inside = (error: ErrorObject): boolean =>
      error.schemaPath.startsWith(prefix) && (error.instancePath === union.instancePath || error.instancePath.startsWith(`${union.instancePath}/`));
    const branches = new Map<string, ErrorObject[]>();
    for (const error of kept.filter(inside)) {
      const branch = error.schemaPath.slice(prefix.length).split('/')[0] ?? '';
      branches.set(branch, [...(branches.get(branch) ?? []), error]);
    }
    if (branches.size === 0) continue;
    const mismatchesTag = (branch: readonly ErrorObject[]): number =>
      branch.some((error) => (error.keyword === 'const' || error.keyword === 'enum') && isChildPath(error.instancePath, union.instancePath)) ? 1 : 0;
    const closest = [...branches.values()].reduce((best, branch) => {
      const tagOrder = mismatchesTag(branch) - mismatchesTag(best);
      return tagOrder < 0 || (tagOrder === 0 && branch.length < best.length) ? branch : best;
    });
    kept = kept.filter((error) => error !== union && (!inside(error) || closest.includes(error)));
  }
  return kept;
}

function isChildPath(path: string, parent: string): boolean {
  return path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes('/');
}

function describeError(error: ErrorObject): string {
  const at = error.instancePath === '' ? '(root)' : error.instancePath.replaceAll(/\/\d+(?=\/|$)/g, '/*');
  const params = error.params as Readonly<Record<string, unknown>>;
  const detail =
    error.keyword === 'additionalProperties' ? ` (${JSON.stringify(params['additionalProperty'])})`
    : error.keyword === 'enum' ? ` ${JSON.stringify(params['allowedValues'])}`
    : '';
  return `${at} ${error.message ?? error.keyword}${detail}`;
}

function valueAt(value: unknown, pointer: string): unknown {
  let current = value;
  for (const token of pointer.split('/').slice(1)) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    current = current !== null && typeof current === 'object' ? (current as Readonly<Record<string, unknown>>)[key] : undefined;
  }
  return current;
}

function excerpt(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined');
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
