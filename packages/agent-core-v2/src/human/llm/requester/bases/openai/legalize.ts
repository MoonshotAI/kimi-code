import type { ContentPart, Message, ThinkPart } from '#/llm/message';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { Pattern } from '#/llm/protocol/rewrite';

import { KNOWN_REASONING_KEYS } from './decode';

function historyReasoningKey(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j]!;
      if (
        part.type === 'think' &&
        part.reasoningKey !== undefined &&
        KNOWN_REASONING_KEYS.includes(part.reasoningKey)
      ) {
        return part.reasoningKey;
      }
    }
  }
  return KNOWN_REASONING_KEYS[0]!;
}

export function resolveOpenAIReasoningKey(
  messages: readonly Message[],
  reasoningKey?: string,
): string {
  return reasoningKey ?? historyReasoningKey(messages);
}

function stampReasoningKey(reasoningKey: string, explicit: boolean): Pattern<Message> {
  const needsReasoningKey = (part: ContentPart): part is ThinkPart => {
    if (part.type !== 'think') return false;
    if (part.reasoningKey === undefined) return true;
    return explicit ? part.reasoningKey !== reasoningKey : !KNOWN_REASONING_KEYS.includes(part.reasoningKey);
  };
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
): readonly Pattern<Message>[] {
  return [stampReasoningKey(resolveOpenAIReasoningKey(messages, reasoningKey), reasoningKey !== undefined)];
}

export const openAIModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP', 'topK', 'stop', 'seed', 'presencePenalty', 'frequencyPenalty'],
};
