/**
 * Turns tool execution results into messages: tool messages for completed, aborted, blocked, and failed
 * calls, and the user message that reports a detached tool's completion.
 */
import {
  createToolMessage,
  createUserMessage,
  type ContentPart,
  type ToolCall,
  type ToolMessage,
  type UserMessage,
} from '#/llm/message';
import { abortedToolOutput } from '#/tool/abort';
import { errorText } from '#/llm/protocol/errors';
import type { ToolDetachAck, ToolResult } from '#/tool/runtime';
import type { AsyncToolOutcome, Cause, ToolCallOutcome } from '../contract/outcome';

export function toolOutcomeMessage(
  toolCall: ToolCall,
  result: ToolResult | ToolDetachAck,
  detached?: true,
): ToolMessage {
  const failed = 'outcome' in result && result.outcome.type !== 'success';
  return createToolMessage(toolCall.id, result.content, {
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
  return { type: 'aborted', message: toolOutcomeMessage(toolCall, result), reason };
}

export function blockedToolOutcome(
  toolCall: ToolCall,
  cause: Cause,
  result?: { readonly content: ContentPart[] },
): ToolCallOutcome {
  const content = result?.content ?? [{ type: 'text', text: cause.message ?? cause.reason }];
  return {
    type: 'blocked',
    message: createToolMessage(toolCall.id, content, { source: 'tool', isError: true }),
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
  return { type: 'failed', message: toolOutcomeMessage(toolCall, result), error };
}

export interface ToolCompletionInput {
  readonly toolCall: ToolCall;
  readonly outcome: AsyncToolOutcome;
  readonly result?: ToolResult;
}

export interface ToolCompletionFactory {
  (input: ToolCompletionInput): UserMessage | Promise<UserMessage>;
  onRejected?(error: unknown, input: ToolCompletionInput): UserMessage | Promise<UserMessage>;
}

export function completionMessage(
  toolCall: ToolCall,
  outcome: AsyncToolOutcome,
  result?: ToolResult,
): UserMessage {
  const label = `${toolCall.name} (tool_call_id=${toolCall.id})`;
  const content: ContentPart[] =
    outcome.type === 'succeeded'
      ? [{ type: 'text', text: `[async tool completed] ${label}` }, ...(result?.content ?? [])]
      : outcome.type === 'aborted'
        ? [{ type: 'text', text: `[async tool aborted] ${label}` }]
        : [{ type: 'text', text: `[async tool failed] ${label}\n${errorText(outcome.error)}` }];
  return createUserMessage(content, { source: 'async-tool', toolCallId: toolCall.id });
}

export async function resolveCompletionMessage(
  input: ToolCompletionInput,
  factory?: ToolCompletionFactory,
): Promise<UserMessage> {
  if (factory !== undefined) return factory(input);
  return completionMessage(input.toolCall, input.outcome, input.result);
}
