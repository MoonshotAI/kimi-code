import type { ContentPart, Message, ThinkPart } from '#/llm/message';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { Pattern } from '#/llm/protocol/pattern';

import { KNOWN_REASONING_KEYS, REASONING_DETAILS_KEY } from './decode';

function historyReasoningKey(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j]!;
      if (
        part.type === 'think' &&
        part.reasoningKey !== undefined &&
        part.reasoningKey !== REASONING_DETAILS_KEY &&
        KNOWN_REASONING_KEYS.includes(part.reasoningKey)
      ) {
        return part.reasoningKey;
      }
    }
  }
}

export function resolveOpenAIReasoningKey(
  messages: readonly Message[],
  reasoningKey?: string,
  detectedReasoningKey?: string,
): string {
  return (
    reasoningKey ??
    detectedReasoningKey ??
    historyReasoningKey(messages) ??
    KNOWN_REASONING_KEYS[0]!
  );
}

function stampReasoningKey(reasoningKey: string): Pattern<Message> {
  const needsReasoningKey = (part: ContentPart): part is ThinkPart =>
    part.type === 'think' && part.reasoningKey === undefined;
  return {
    name: 'stampReasoningKey',
    rewrite(items, index) {
      const message = items[index];
      if (message === undefined || !message.content.some(needsReasoningKey)) return null;
      const content = message.content.map((part): ContentPart =>
        needsReasoningKey(part) ? { ...part, reasoningKey } : part,
      );
      return { consumed: 1, replacement: [{ ...message, content }] };
    },
  };
}

export function openAIThinkingHistoryPatterns(
  messages: readonly Message[],
  reasoningKey?: string,
  detectedReasoningKey?: string,
): readonly Pattern<Message>[] {
  const resolved = resolveOpenAIReasoningKey(messages, reasoningKey, detectedReasoningKey);
  return [stampReasoningKey(resolved)];
}

export const openAIModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP', 'topK', 'stop', 'seed', 'presencePenalty', 'frequencyPenalty'],
};
