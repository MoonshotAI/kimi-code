import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const DRAFT_07_AJV = new Ajv({ strict: false, allErrors: true, verbose: true });
addFormats(DRAFT_07_AJV);

const DRAFT_2019_AJV = new Ajv2019({ strict: false, allErrors: true, verbose: true });
addFormats(DRAFT_2019_AJV);

const DRAFT_2020_AJV = new Ajv2020({ strict: false, allErrors: true, verbose: true });
addFormats(DRAFT_2020_AJV);

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

// Mixing JSON Schema dialects in a single Ajv instance is unsafe because
// keyword semantics differ, e.g. draft-07 tuple `items` vs 2020-12 `prefixItems`.
function ajvFor(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  const $schema = schema['$schema'];
  if (typeof $schema === 'string') {
    if ($schema.includes('2020-12')) return DRAFT_2020_AJV;
    if ($schema.includes('2019-09')) return DRAFT_2019_AJV;
    return DRAFT_07_AJV;
  }
  if (containsSchemaKeyword(schema, DRAFT_2020_KEYWORDS)) return DRAFT_2020_AJV;
  if (containsSchemaKeyword(schema, DRAFT_2019_KEYWORDS)) return DRAFT_2019_AJV;
  return DRAFT_07_AJV;
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

/** @internal */
export interface JsonArray extends Array<JsonType> {}

/** @internal */
export interface JsonObject extends Record<string, JsonType> {}

export type ToolArgsValidator = ValidateFunction<JsonType>;

type SchemaObject = Record<string, unknown>;

function asSchemaObject(value: unknown): SchemaObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as SchemaObject;
}

function schemaProperties(error: ErrorObject): SchemaObject | undefined {
  const parentSchema = asSchemaObject(error.parentSchema);
  if (parentSchema === undefined) return undefined;
  return asSchemaObject(parentSchema['properties']);
}

function validProperties(error: ErrorObject): string | undefined {
  const properties = schemaProperties(error);
  if (properties === undefined) return undefined;

  const names = Object.keys(properties);
  return names.length === 0 ? undefined : names.join(', ');
}

function formatTypeList(value: unknown): string | undefined {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    const types = value.filter((item): item is string => typeof item === 'string');
    return types.length === 0 ? undefined : types.join(' or ');
  }

  return undefined;
}

function expectedType(schema: unknown): string | undefined {
  const schemaObject = asSchemaObject(schema);
  if (schemaObject === undefined) return undefined;

  const directType = formatTypeList(schemaObject['type']);
  if (directType !== undefined) return directType;

  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schemaObject[key];
    if (!Array.isArray(branches)) continue;

    const branchTypes = new Set<string>();
    for (const branch of branches) {
      const branchType = expectedType(branch);
      if (branchType !== undefined) branchTypes.add(branchType);
    }
    if (branchTypes.size > 0) return [...branchTypes].join(' or ');
  }

  return undefined;
}

function expectedPropertyType(error: ErrorObject, property: string): string | undefined {
  const properties = schemaProperties(error);
  if (properties === undefined) return undefined;
  return expectedType(properties[property]);
}

function formatValidationError(error: ErrorObject): string {
  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    const property = String(error.params['missingProperty']);
    const type = expectedPropertyType(error, property);
    const typeHint = type === undefined ? '' : ` (expected ${type})`;
    return `must have required property '${property}'${typeHint}`;
  }

  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    const property = String(error.params['additionalProperty']);
    const properties = validProperties(error);
    const propertiesHint = properties === undefined ? '' : `; valid properties: ${properties}`;
    return `must NOT have additional property '${property}'${propertiesHint}`;
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
