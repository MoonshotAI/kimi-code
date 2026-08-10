import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

/**
 * Test-only schema validator. Kosong's e2e tests need a way to validate tool
 * arguments inside the SimpleToolset fixture, but kosong itself no longer
 * ships a runtime validator (the real one moved to agent-core). Fixtures
 * stick with draft-07 since kosong's own test schemas don't exercise newer
 * dialects.
 */

const AJV = new Ajv({ strict: false, allErrors: true });

export type JsonValue = null | number | string | boolean | JsonArray | JsonObject;
interface JsonArray extends Array<JsonValue> {}
interface JsonObject extends Record<string, JsonValue> {}

export type ArgsValidator = ValidateFunction<JsonValue>;

export function compileArgsValidator(schema: Record<string, unknown>): ArgsValidator {
  return AJV.compile(schema) as ArgsValidator;
}

export function validateArgs(validator: ArgsValidator, args: JsonValue): string | null {
  if (validator(args)) return null;
  const errors = validator.errors ?? [];
  if (errors.length === 0) return 'Tool parameter validation failed';
  return errors.map(formatError).join('; ');
}

function formatError(error: ErrorObject): string {
  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    return `must have required property '${String(error.params['missingProperty'])}'`;
  }
  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    return `must NOT have additional property '${String(error.params['additionalProperty'])}'`;
  }
  const path = error.instancePath ? `${error.instancePath} ` : '';
  return `${path}${error.message ?? 'is invalid'}`;
}
