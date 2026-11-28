import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { log } from '#/utils/log';

type AnyAjv = Ajv | Ajv2019 | Ajv2020;

const ajvOptions = {
  strict: false,
  allErrors: true,
  logger: {
    log: (...args: unknown[]) => log.debug(args.map(String).join(' ')),
    warn: (...args: unknown[]) => log.warn(args.map(String).join(' ')),
    error: (...args: unknown[]) => log.error(args.map(String).join(' ')),
  },
};

let draft07Ajv: Ajv | undefined;
let draft2019Ajv: Ajv2019 | undefined;
let draft2020Ajv: Ajv2020 | undefined;

function withFormats<T extends AnyAjv>(ajv: T): T {
  addFormats(ajv);
  return ajv;
}

function draft07(): Ajv {
  return (draft07Ajv ??= withFormats(new Ajv(ajvOptions)));
}

function draft2019(): Ajv2019 {
  return (draft2019Ajv ??= withFormats(new Ajv2019(ajvOptions)));
}

function draft2020(): Ajv2020 {
  return (draft2020Ajv ??= withFormats(new Ajv2020(ajvOptions)));
}

const DRAFT_2019_KEYWORDS = new Set([
  'dependentRequired',
  'dependentSchemas',
  'maxContains',
  'minContains',
  'unevaluatedItems',
  'unevaluatedProperties',
  '$recursiveAnchor',
  '$recursiveRef',
]);

const DRAFT_2020_KEYWORDS = new Set(['prefixItems', '$dynamicAnchor', '$dynamicRef']);

function ajvFor(schema: Record<string, unknown>): AnyAjv {
  const $schema = schema['$schema'];
  if (typeof $schema === 'string') {
    if ($schema.includes('2020-12')) return draft2020();
    if ($schema.includes('2019-09')) return draft2019();
    return draft07();
  }
  if (containsSchemaKeyword(schema, DRAFT_2020_KEYWORDS)) return draft2020();
  if (containsSchemaKeyword(schema, DRAFT_2019_KEYWORDS)) return draft2019();
  return draft07();
}

function containsSchemaKeyword(value: unknown, keywords: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSchemaKeyword(item, keywords));
  }
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (keywords.has(key)) return true;
    if (containsSchemaKeyword(child, keywords)) return true;
  }
  return false;
}

export type JsonType = null | number | string | boolean | JsonArray | JsonObject;

export interface JsonArray extends Array<JsonType> {}

export interface JsonObject extends Record<string, JsonType> {}

export type ToolArgsValidator = ValidateFunction<JsonType>;

function formatValidationError(error: ErrorObject): string {
  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    return `must have required property '${String(error.params['missingProperty'])}'`;
  }

  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    return `must NOT have additional property '${String(error.params['additionalProperty'])}'`;
  }

  const path = error.instancePath ? `${error.instancePath} ` : '';
  return `${path}${error.message ?? 'is invalid'}`;
}

export function compileToolArgsValidator(schema: Record<string, unknown>): ToolArgsValidator {
  return ajvFor(schema).compile(schema) as ToolArgsValidator;
}

export function validateToolArgs(validator: ToolArgsValidator, args: JsonType): string | null {
  const valid = validator(args);
  if (valid) {
    return null;
  }

  const errors = validator.errors ?? [];
  if (errors.length === 0) {
    return 'Tool parameter validation failed';
  }

  return errors.map((error) => formatValidationError(error)).join('; ');
}

export function parseToolCallArguments(raw: unknown): {
  readonly data: unknown;
  readonly parseFailed: boolean;
  readonly error?: string;
} {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.length === 0)) {
    return { data: {}, parseFailed: false };
  }
  if (typeof raw !== 'string') {
    return { data: raw, parseFailed: false };
  }
  try {
    return { data: JSON.parse(raw) as unknown, parseFailed: false };
  } catch (error) {
    return {
      data: {},
      parseFailed: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyToolArgAliases(
  aliases: Readonly<Record<string, string>> | undefined,
  args: unknown,
): unknown {
  if (aliases === undefined) {
    return args;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return args;
  }
  const record = args as Record<string, unknown>;
  let next: Record<string, unknown> | undefined;
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!(alias in record)) {
      continue;
    }
    next ??= { ...record };
    if (!(canonical in record)) {
      next[canonical] = record[alias];
    }
    delete next[alias];
  }
  return next ?? args;
}
