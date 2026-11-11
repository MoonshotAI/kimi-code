/**
 * Turns tool execution results into history: tool entries for completed, aborted, blocked, and failed
 * calls, and the user entry that reports a detached tool's completion.
 */
import { createToolMessage, type ContentPart, type ToolCall } from '#/llm/message';
import { abortedToolOutput } from '#/tool/abort';
import { errorText } from '#/llm/protocol/errors';
import { createToolEntry, createUserEntry, type ToolEntry, type UserEntry } from '#/history/history';
import type { ToolDetachAck, ToolResult } from '#/tool/runtime';
import type { AsyncToolOutcome, Cause, ToolCallOutcome } from '../contract/outcome';

export function toolEntry(toolCall: ToolCall, result: ToolResult | ToolDetachAck, detached?: true): ToolEntry {
  const failed = 'outcome' in result && result.outcome.type !== 'success';
  return createToolEntry(createToolMessage(toolCall.id, result.content), {
    source: 'tool',
    isError: failed ? true : undefined,
    stopTurn: 'stopTurn' in result && result.stopTurn === true ? true : undefined,
    detached,
  });
}

export function abortedToolOutcome(toolCall: ToolCall, reason?: unknown): ToolCallOutcome {
  const text = abortedToolOutput(toolCall.name, reason);
  const error = {
    outcome: 'aborted' as const,
    type: 'stopped' as const,
    phase: 'execute' as const,
    reason: text,
    data: reason,
  };
  const result: ToolResult = {
    toolCallId: toolCall.id,
    content: [{ type: 'text', text }],
    outcome: { type: 'aborted', error },
  };
  return { type: 'aborted', entry: toolEntry(toolCall, result), reason };
}

export function blockedToolOutcome(
  toolCall: ToolCall,
  cause: Cause,
  result?: { readonly content: ContentPart[] },
): ToolCallOutcome {
  const content = result?.content ?? [{ type: 'text', text: cause.message ?? cause.reason }];
  return {
    type: 'blocked',
    entry: createToolEntry(createToolMessage(toolCall.id, content), { source: 'tool', isError: true }),
    cause,
  };
}

export function failedToolOutcome(toolCall: ToolCall, error: unknown): ToolCallOutcome {
  const failure = {
    outcome: 'failed' as const,
    type: 'unknown' as const,
    phase: 'execute' as const,
    reason: errorText(error),
    data: error,
  };
  const result: ToolResult = {
    toolCallId: toolCall.id,
    content: [{ type: 'text', text: errorText(error) }],
    outcome: { type: 'failed', error: failure },
  };
  return { type: 'failed', entry: toolEntry(toolCall, result), error };
}

export interface ToolCompletionInput {
  readonly toolCall: ToolCall;
  readonly outcome: AsyncToolOutcome;
  readonly result?: ToolResult;
}

export interface ToolCompletionFactory {
  (input: ToolCompletionInput): UserEntry | Promise<UserEntry>;
  onRejected?(error: unknown, input: ToolCompletionInput): UserEntry | Promise<UserEntry>;
}

export function completionEntry(
  toolCall: ToolCall,
  outcome: AsyncToolOutcome,
  result?: ToolResult,
): UserEntry {
  const label = `${toolCall.name} (tool_call_id=${toolCall.id})`;
  const content: ContentPart[] =
    outcome.type === 'succeeded'
      ? [{ type: 'text', text: `[async tool completed] ${label}` }, ...(result?.content ?? [])]
      : outcome.type === 'aborted'
        ? [{ type: 'text', text: `[async tool aborted] ${label}` }]
        : [{ type: 'text', text: `[async tool failed] ${label}\n${errorText(outcome.error)}` }];
  return createUserEntry({ role: 'user', content }, { source: 'async-tool', toolCallId: toolCall.id });
}

export async function resolveCompletionEntry(
  input: ToolCompletionInput,
  factory?: ToolCompletionFactory,
): Promise<UserEntry> {
  if (factory !== undefined) return factory(input);
  return completionEntry(input.toolCall, input.outcome, input.result);
}
