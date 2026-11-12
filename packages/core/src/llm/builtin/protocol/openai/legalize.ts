/**
 * OpenAI Chat Completions legality rules: resolving which reasoning key carries thinking content,
 * stamping it onto history thinking parts, and the supported sampling parameters.
 */
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
  detectedReasoningKey?: string | (() => string | undefined),
): string {
  const detected = typeof detectedReasoningKey === 'function' ? detectedReasoningKey() : detectedReasoningKey;
  return (
    reasoningKey ??
    detected ??
    historyReasoningKey(messages) ??
    KNOWN_REASONING_KEYS[0]!
  );
}

/**
 * Converts a message with untagged thinking parts into a copy where every such part has the
 * resolved reasoning key, leaving all other content unchanged.
 *
 * @example
 * // With `reasoningKey = 'reasoning_content'`:
 * // Input:
 * {
 *   role: 'assistant',
 *   toolCalls: [],
 *   content: [{ type: 'think', think: 'Compare options' }], // ←
 * }
 * // Output:
 * {
 *   role: 'assistant',
 *   toolCalls: [],
 *   content: [
 *     { type: 'think', think: 'Compare options', reasoningKey: 'reasoning_content' }, // ←
 *   ],
 * }
 */
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
  detectedReasoningKey?: string | (() => string | undefined),
): readonly Pattern<Message>[] {
  const resolved = resolveOpenAIReasoningKey(messages, reasoningKey, detectedReasoningKey);
  return [stampReasoningKey(resolved)];
}

export const openAIModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP', 'topK', 'stop', 'seed', 'presencePenalty', 'frequencyPenalty'],
};
