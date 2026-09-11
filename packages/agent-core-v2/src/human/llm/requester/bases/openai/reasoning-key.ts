import type { ReasoningDetailsElement, StreamedMessagePart, ThinkPart } from '#/llm/message';

export const KNOWN_REASONING_KEYS = [
  'reasoning_content',
  'reasoning_details',
  'reasoning',
] as const;

export type ReasoningKey = (typeof KNOWN_REASONING_KEYS)[number];

export const DEFAULT_REASONING_KEY: ReasoningKey = KNOWN_REASONING_KEYS[0];

export function extractReasoning(
  source: unknown,
  explicitKey?: string,
): { key: string; value: string } | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const keys: readonly string[] = explicitKey !== undefined ? [explicitKey] : KNOWN_REASONING_KEYS;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return { key, value };
  }
  return undefined;
}

export const REASONING_DETAILS_KEY = 'reasoning_details';

function toReasoningDetailsElement(
  value: unknown,
  position: number,
): ReasoningDetailsElement | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : undefined;
  if (type !== undefined && type !== 'summary' && type !== 'encrypted') return undefined;
  const index = typeof record['index'] === 'number' ? record['index'] : position;
  const summary = typeof record['summary'] === 'string' ? record['summary'] : undefined;
  const encrypted = typeof record['encrypted'] === 'string' ? record['encrypted'] : undefined;
  return { type, index, summary, encrypted };
}

export function extractReasoningDetails(
  source: unknown,
): ReasoningDetailsElement[] | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[REASONING_DETAILS_KEY];
  if (!Array.isArray(value)) return undefined;
  const elements: ReasoningDetailsElement[] = [];
  for (const [position, item] of value.entries()) {
    const element = toReasoningDetailsElement(item, position);
    if (element !== undefined) elements.push(element);
  }
  return elements;
}

export function convertReasoningDetails(
  elements: readonly ReasoningDetailsElement[],
  hiddenSummary = false,
): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];
  const summaries: ReasoningDetailsElement[] = [];
  for (const element of elements) {
    if (element.type !== 'encrypted' && element.summary !== undefined && element.summary.length > 0) {
      if (hiddenSummary) {
        summaries.push(element);
      } else {
        parts.push({
          type: 'think',
          think: element.summary,
          meta: { detailsIndex: element.index },
        } satisfies ThinkPart);
      }
    }
    if (element.type !== 'summary' && element.encrypted !== undefined && element.encrypted.length > 0) {
      parts.push({
        type: 'think',
        think: '',
        meta: { encrypted: element.encrypted, detailsIndex: element.index },
      } satisfies ThinkPart);
    }
  }
  if (summaries.length > 0) {
    parts.unshift({
      type: 'think',
      think: '',
      details: summaries,
      meta: { reasoningKey: DEFAULT_REASONING_KEY },
    } satisfies ThinkPart);
  }
  return parts;
}
