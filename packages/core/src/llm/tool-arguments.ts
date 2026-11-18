import type { Message, ToolCall, ToolDescription } from '#/llm/message';
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
  | 'schema';

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

function schemaError(tool: ToolDescription, value: Record<string, unknown>): string | null {
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
  if (cached.error !== undefined) return cached.error;
  return validateToolArgs(cached.validator, value as JsonType);
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
    const error = schemaError(tool, value);
    if (error !== null) {
      return { issue: { reason: 'schema', message: error } };
    }
  }
  return { value };
}

export function llmToolArgumentsIssue(raw: string | null): ToolArgumentsIssue | undefined {
  if (raw === null || raw === '') return undefined;
  return parseLlmToolArguments(raw).issue;
}

export function invalidToolCallText(name: string, issue: string): string {
  return `Tool call "${name}" was not executed because its arguments were invalid: ${issue}`;
}

export function invalidToolArgumentsError(
  call: ToolCall,
  tools: readonly ToolDescription[],
): LlmErrorMessage<'invalid_tool_arguments'> | null {
  const tool = tools.find((entry) => entry.name === call.name);
  const result = parseLlmToolArguments(call.arguments, tool);
  if (result.issue === undefined) return null;
  return {
    kind: 'invalid_tool_arguments',
    message: `${invalidToolCallText(call.name, result.issue.message)} Generate a new tool call with valid arguments.`,
    retryable: true,
  };
}

export interface InvalidToolCall {
  readonly call: ToolCall;
  readonly issue: ToolArgumentsIssue;
}

export interface ToolCallHistoryCleanup {
  readonly messages: readonly Message[];
  readonly invalid: readonly InvalidToolCall[];
}

export function cleanToolCallHistory(
  messages: readonly Message[],
  tools: readonly ToolDescription[],
): ToolCallHistoryCleanup {
  const invalid: InvalidToolCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      const tool = tools.find((entry) => entry.name === call.name);
      const issue = parseLlmToolArguments(call.arguments, tool).issue;
      if (issue !== undefined) invalid.push({ call, issue });
    }
  }
  if (invalid.length === 0) return { messages, invalid };

  const invalidIds = new Set(invalid.map(({ call }) => call.id));
  const cleaned: Message[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!invalidIds.has(message.toolCallId)) cleaned.push(message);
      continue;
    }
    if (message.role !== 'assistant') {
      cleaned.push(message);
      continue;
    }
    const rejected = invalid.filter(({ call }) => message.toolCalls.includes(call));
    if (rejected.length === 0) {
      cleaned.push(message);
      continue;
    }
    cleaned.push({
      ...message,
      content: [
        ...message.content,
        ...rejected.map(({ call, issue }) => ({
          type: 'text' as const,
          text: `A previous call to "${call.name}" was removed from this request because its arguments were invalid: ${issue.message}`,
        })),
      ],
      toolCalls: message.toolCalls.filter((call) => !invalidIds.has(call.id)),
    });
  }
  return { messages: cleaned, invalid };
}

export function restoreJournalToolArguments(args: unknown): {
  readonly arguments: string | null;
  readonly issue?: ToolArgumentsIssue;
} {
  if (args === undefined) return { arguments: null };
  const raw = typeof args === 'string' ? args : JSON.stringify(args) ?? null;
  return { arguments: raw, issue: llmToolArgumentsIssue(raw) };
}
