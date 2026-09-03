import { createToolMessage } from '#/kosong/contract/message';

import type { ContextMessage } from './types';

export const INHERITED_IN_FLIGHT_TOOL_OUTPUT =
  'This tool call was still executing when this conversation snapshot was inherited from the source agent, so its result is not part of this context. The outcome is unknown — do not assume it succeeded or failed, and do not wait for it.';

export function closeTrailingOpenToolExchange(
  history: readonly ContextMessage[],
): ContextMessage[] {
  let lastNonToolIndex = history.length - 1;
  while (lastNonToolIndex >= 0 && history[lastNonToolIndex]?.role === 'tool') {
    lastNonToolIndex -= 1;
  }

  const assistant = history[lastNonToolIndex];
  if (assistant === undefined) return [];
  if (assistant.role !== 'assistant' || assistant.toolCalls.length === 0) return [...history];

  const answeredToolCallIds = new Set(
    history
      .slice(lastNonToolIndex + 1)
      .map((message) => message.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
  );
  const openCalls = assistant.toolCalls.filter(
    (toolCall) => !answeredToolCallIds.has(toolCall.id),
  );
  if (openCalls.length === 0) return [...history];
  const settledAssistant =
    assistant.partial === true ? { ...assistant, partial: undefined } : assistant;
  return [
    ...history.slice(0, lastNonToolIndex),
    settledAssistant,
    ...history.slice(lastNonToolIndex + 1),
    ...openCalls.map((toolCall) =>
      createToolMessage(toolCall.id, INHERITED_IN_FLIGHT_TOOL_OUTPUT),
    ),
  ];
}
