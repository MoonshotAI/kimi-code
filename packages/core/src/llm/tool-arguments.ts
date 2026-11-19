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
): LlmErrorMessage | null {
  const tool = tools.find((entry) => entry.name === call.name);
  const result = parseLlmToolArguments(call.arguments, tool);
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

export interface InvalidToolCall {
  readonly call: ToolCall;
  readonly issue: ToolArgumentsIssue;
}

export interface ToolCallHistoryCleanup {
  readonly messages: readonly Message[];
  readonly invalid: readonly InvalidToolCall[];
}

function historicalTool(
  messages: readonly Message[],
  call: ToolCall,
  currentTools: readonly ToolDescription[],
): ToolDescription | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'system') continue;
    const tool = message.tools?.find((entry) => entry.name === call.name);
    if (tool !== undefined) return tool;
  }
  return currentTools.find((entry) => entry.name === call.name);
}

export function cleanToolCallHistory(
  messages: readonly Message[],
  tools: readonly ToolDescription[],
): ToolCallHistoryCleanup {
  const invalid: InvalidToolCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      const issue = parseLlmToolArguments(call.arguments, historicalTool(messages, call, tools)).issue;
      if (issue !== undefined && issue.reason !== 'schema_config') invalid.push({ call, issue });
    }
  }
  if (invalid.length === 0) return { messages, invalid };

  const invalidCalls = new Set(invalid.map(({ call }) => call));
  const pending = new Map<string, ToolCall[]>();
  const cleaned: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) {
        const queue = pending.get(call.id) ?? [];
        queue.push(call);
        pending.set(call.id, queue);
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
        toolCalls: message.toolCalls.filter((call) => !invalidCalls.has(call)),
      });
      continue;
    }
    if (message.role === 'tool') {
      const queue = pending.get(message.toolCallId);
      const call = queue?.shift();
      if (queue !== undefined && queue.length === 0) pending.delete(message.toolCallId);
      if (call === undefined || !invalidCalls.has(call)) cleaned.push(message);
      continue;
    }
    cleaned.push(message);
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
