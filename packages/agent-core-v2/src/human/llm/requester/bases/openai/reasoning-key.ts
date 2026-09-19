import type { StreamedMessagePart, ThinkPart } from '#/llm/message';

export const KNOWN_REASONING_KEYS = [
  'reasoning_content',
  'reasoning_details',
  'reasoning',
] as const;

export type ReasoningKey = (typeof KNOWN_REASONING_KEYS)[number];

export const DEFAULT_REASONING_KEY: ReasoningKey = KNOWN_REASONING_KEYS[0];

export function extractReasoningStrings(
  source: unknown,
  keys: readonly string[] = KNOWN_REASONING_KEYS,
): { key: string; value: string }[] {
  if (typeof source !== 'object' || source === null) return [];
  const record = source as Record<string, unknown>;
  const found: { key: string; value: string }[] = [];
  const seenValues = new Set<string>();
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string' || seenValues.has(value)) continue;
    seenValues.add(value);
    found.push({ key, value });
  }
  return found;
}

export function extractReasoning(
  source: unknown,
  explicitKey?: string | readonly string[],
): { key: string; value: string } | undefined {
  if (explicitKey !== undefined) {
    const keys = typeof explicitKey === 'string' ? [explicitKey] : explicitKey;
    return extractReasoningStrings(source, keys)[0];
  }
  return extractReasoningStrings(source)[0];
}

export class ReasoningKeyDialect {
  private _detected: string | undefined;

  constructor(private readonly _explicitKey?: string | readonly string[]) {}

  observe(source: unknown): string | undefined {
    const found = extractReasoning(source, this._explicitKey);
    if (found === undefined) return undefined;
    if (typeof this._explicitKey !== 'string' && this._detected === undefined) {
      this._detected = found.key;
    }
    return found.value;
  }

  outboundKey(): string {
    if (typeof this._explicitKey === 'string') return this._explicitKey;
    return this._detected ?? this._explicitKey?.[0] ?? DEFAULT_REASONING_KEY;
  }
}

export const REASONING_DETAILS_KEY = 'reasoning_details';

export interface ReasoningDetailsElement {
  readonly type?: string;
  readonly index: number;
  readonly summary?: string;
  readonly encrypted?: string;
}

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
  for (const element of elements) {
    if (element.type !== 'encrypted' && element.summary !== undefined && element.summary.length > 0) {
      parts.push({
        type: 'think',
        think: element.summary,
        detailsIndex: element.index,
        hidden: hiddenSummary ? true : undefined,
        reasoningKey: REASONING_DETAILS_KEY,
      } satisfies ThinkPart);
    }
    if (element.type !== 'summary' && element.encrypted !== undefined && element.encrypted.length > 0) {
      parts.push({
        type: 'think',
        think: '',
        encrypted: element.encrypted,
        detailsIndex: element.index,
        reasoningKey: REASONING_DETAILS_KEY,
      } satisfies ThinkPart);
    }
  }
  return parts;
}
