import { createToolMessage } from '#human/llm/message';
import {
  isAssistantEntry,
  isToolEntry,
  type HistoryMessage,
  type ToolEntry,
} from '#human/agent/turn';

export const INHERITED_IN_FLIGHT_TOOL_OUTPUT =
  'This tool call was still executing when this conversation snapshot was inherited from the source agent, so its result is not part of this context. The outcome is unknown — do not assume it succeeded or failed, and do not wait for it.';

export function closeTrailingOpenToolExchange(
  history: readonly HistoryMessage[],
): HistoryMessage[] {
  let lastNonToolIndex = history.length - 1;
  while (lastNonToolIndex >= 0 && history[lastNonToolIndex]?.message.role === 'tool') {
    lastNonToolIndex -= 1;
  }

  const assistant = history[lastNonToolIndex];
  if (assistant === undefined) return [];
  if (!isAssistantEntry(assistant) || assistant.message.toolCalls.length === 0) return [...history];

  const answeredToolCallIds = new Set(
    history
      .slice(lastNonToolIndex + 1)
      .map((entry) => (isToolEntry(entry) ? entry.message.toolCallId : undefined))
      .filter((toolCallId): toolCallId is string => toolCallId !== undefined),
  );
  const openCalls = assistant.message.toolCalls.filter(
    (toolCall) => !answeredToolCallIds.has(toolCall.id),
  );
  if (openCalls.length === 0) return [...history];
  const settledAssistant =
    assistant.meta?.partial === true
      ? { ...assistant, meta: { ...assistant.meta, partial: undefined } }
      : assistant;
  return [
    ...history.slice(0, lastNonToolIndex),
    settledAssistant,
    ...history.slice(lastNonToolIndex + 1),
    ...openCalls.map(
      (toolCall): ToolEntry => ({
        message: createToolMessage(toolCall.id, INHERITED_IN_FLIGHT_TOOL_OUTPUT),
        meta: {},
      }),
    ),
  ];
}
