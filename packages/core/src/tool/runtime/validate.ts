/**
 * Validates a call's arguments against the tool's parameter schema, caching the compiled validator per tool.
 */
import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '#/tool/args-validator';

import type { ExecutableTool } from './types';

interface CachedValidator {
  readonly schema: Record<string, unknown>;
  readonly validator: ToolArgsValidator;
}

const validators = new WeakMap<object, CachedValidator>();

export function toolArgsError(tool: ExecutableTool<any, any, any, any>, args: unknown): string | null {
  const schema = tool.parameters;
  let cached = validators.get(tool);
  if (cached === undefined || cached.schema !== schema) {
    try {
      cached = { schema, validator: compileToolArgsValidator(schema) };
      validators.set(tool, cached);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(cached.validator, args as JsonType);
}
