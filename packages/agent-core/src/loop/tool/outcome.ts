import { createToolMessage, type ContentPart, type ToolCall } from '#/llm/message';
import { errorText } from '#/llm/protocol/errors';
import { createToolEntry, createUserEntry, type ToolEntry, type UserEntry } from '#/history/message';
import type { ToolResult } from '#/tool/index';
import type { AsyncToolOutcome, Cause, ToolCallOutcome } from '../contract/outcome';

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function withNotes(result: ToolResult, notes: readonly string[]): ToolResult {
  if (notes.length === 0) return result;
  return { ...result, content: [...result.content, ...notes.map((text) => ({ type: 'text' as const, text }))] };
}

export function toolEntry(toolCall: ToolCall, result: ToolResult, detached?: true): ToolEntry {
  return createToolEntry(createToolMessage(toolCall.id, result.content), {
    source: 'tool',
    ...(result.isError === true ? { isError: true as const } : {}),
    ...(result.stopTurn === true ? { stopTurn: true as const } : {}),
    ...(detached === true ? { detached } : {}),
  });
}

export function abortedToolOutcome(toolCall: ToolCall, reason?: unknown): ToolCallOutcome {
  return { type: 'aborted', entry: toolEntry(toolCall, errorResult('aborted')), reason };
}

export function blockedToolOutcome(toolCall: ToolCall, cause: Cause, result?: ToolResult): ToolCallOutcome {
  return {
    type: 'blocked',
    entry: toolEntry(toolCall, { ...(result ?? errorResult(cause.message ?? cause.reason)), isError: true }),
    cause,
  };
}

export function failedToolOutcome(toolCall: ToolCall, error: unknown): ToolCallOutcome {
  return { type: 'failed', entry: toolEntry(toolCall, errorResult(errorText(error))), error };
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
