import type { ToolCall, ToolDescription } from '#/llm/message';
import type { LlmErrorMessage } from '#/llm/response';
import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '#/tool/args';

export type ToolArgumentsIssueReason =
  | 'invalid_json'
  | 'not_an_object'
  | 'unknown_tool'
  | 'schema'
  | 'schema_config';

export interface ToolArgumentsIssue {
  readonly reason: ToolArgumentsIssueReason;
  readonly message: string;
}

export type ToolArgumentsResult =
  | { readonly value: Record<string, unknown>; readonly issue?: never }
  | { readonly value?: never; readonly issue: ToolArgumentsIssue };

type CachedValidator =
  | {
      readonly parameters: Record<string, unknown>;
      readonly validator: ToolArgsValidator;
      readonly error?: never;
    }
  | {
      readonly parameters: Record<string, unknown>;
      readonly validator?: never;
      readonly error: string;
    };

const validators = new WeakMap<ToolDescription, CachedValidator>();

function schemaIssue(tool: ToolDescription, value: Record<string, unknown>): ToolArgumentsIssue | null {
  let cached = validators.get(tool);
  if (cached === undefined || cached.parameters !== tool.parameters) {
    try {
      cached = { parameters: tool.parameters, validator: compileToolArgsValidator(tool.parameters) };
    } catch (error) {
      cached = {
        parameters: tool.parameters,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    validators.set(tool, cached);
  }
  if (cached.error !== undefined) return { reason: 'schema_config', message: cached.error };
  const message = validateToolArgs(cached.validator, value as JsonType);
  return message === null ? null : { reason: 'schema', message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLlmToolArguments(
  raw: string | null,
  tool?: ToolDescription,
): ToolArgumentsResult {
  let value: unknown;
  if (raw === null || raw === '') {
    if (tool === undefined) {
      return {
        issue: {
          reason: 'unknown_tool',
          message: 'Empty arguments require a tool description that permits a no-argument call.',
        },
      };
    }
    value = {};
  } else {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return {
        issue: {
          reason: 'invalid_json',
          message: 'Tool arguments are not valid JSON.',
        },
      };
    }
  }
  if (!isObject(value)) {
    return {
      issue: {
        reason: 'not_an_object',
        message: 'Tool arguments must be a JSON object.',
      },
    };
  }
  if (tool !== undefined) {
    const issue = schemaIssue(tool, value);
    if (issue !== null) return { issue };
  }
  return { value };
}

export function invalidToolCallText(name: string, issue: string): string {
  return `Tool call "${name}" was not executed because its arguments were invalid: ${issue}`;
}

export function invalidToolArgumentsError(
  call: ToolCall,
  tools: ReadonlyMap<string, ToolDescription>,
): LlmErrorMessage | null {
  const result = parseLlmToolArguments(call.arguments, tools.get(call.name));
  if (result.issue === undefined) return null;
  if (result.issue.reason === 'schema_config') {
    return {
      kind: 'syntax',
      code: 'request_format',
      message: `Tool "${call.name}" has an invalid parameter schema: ${result.issue.message}`,
    };
  }
  return {
    kind: 'invalid_tool_arguments',
    message: `${invalidToolCallText(call.name, result.issue.message)} Generate a new tool call with valid arguments.`,
    retryable: true,
  };
}
