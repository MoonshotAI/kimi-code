/**
 * `kosong/provider` domain (L2) — Chat Completions stream tool-call buffering.
 *
 * Shared mechanics for the OpenAI-family bases: folds streamed
 * `delta.tool_calls` entries into buffered per-index tool calls, emitting a
 * `function` header once a concrete name arrives and `tool_call_part` deltas
 * for subsequent argument chunks.
 */

import type { StreamedMessagePart, ToolCall } from '#/kosong/contract/message';

export interface ChatCompletionStreamToolFunctionDelta {
  readonly name?: string;
  readonly arguments?: string;
}

export interface ChatCompletionStreamToolCallDelta {
  readonly index?: number | string;
  readonly id?: string;
  readonly function?: ChatCompletionStreamToolFunctionDelta | null;
}

export interface BufferedChatCompletionToolCall {
  id?: string;
  arguments: string;
  emitted: boolean;
}

export function convertChatCompletionStreamToolCall(
  toolCall: ChatCompletionStreamToolCallDelta,
  bufferedByIndex: Map<number | string, BufferedChatCompletionToolCall>,
): StreamedMessagePart[] {
  if (toolCall.function === undefined || toolCall.function === null) {
    return [];
  }

  const streamIndex = toolCall.index;
  const functionName = toolCall.function.name;
  const functionArguments = toolCall.function.arguments;
  const hasConcreteName = typeof functionName === 'string' && functionName.length > 0;
  const hasArguments = typeof functionArguments === 'string' && functionArguments.length > 0;

  if (streamIndex === undefined) {
    if (hasConcreteName) {
      return [
        {
          type: 'function',
          id: toolCall.id ?? crypto.randomUUID(),
          name: functionName,
          arguments: functionArguments ?? null,
        } satisfies ToolCall,
      ];
    }

    if (hasArguments) {
      return [
        { type: 'tool_call_part', argumentsPart: functionArguments } satisfies StreamedMessagePart,
      ];
    }

    return [];
  }

  const buffered = bufferedByIndex.get(streamIndex) ?? { arguments: '', emitted: false };
  if (toolCall.id !== undefined) {
    buffered.id = toolCall.id;
  }

  if (!buffered.emitted) {
    if (!hasConcreteName) {
      if (hasArguments) {
        buffered.arguments += functionArguments;
      }
      bufferedByIndex.set(streamIndex, buffered);
      return [];
    }

    buffered.emitted = true;
    const initialArguments =
      buffered.arguments.length > 0
        ? buffered.arguments + (functionArguments ?? '')
        : (functionArguments ?? null);
    buffered.arguments = '';
    bufferedByIndex.set(streamIndex, buffered);

    const toolCallHeader: ToolCall = {
      type: 'function',
      id: buffered.id ?? toolCall.id ?? crypto.randomUUID(),
      name: functionName,
      arguments: initialArguments,
      _streamIndex: streamIndex,
    };
    return [toolCallHeader];
  }

  if (!hasArguments) {
    return [];
  }

  const part: StreamedMessagePart & { index: number | string } = {
    type: 'tool_call_part',
    argumentsPart: functionArguments,
    index: streamIndex,
  };
  return [part];
}
