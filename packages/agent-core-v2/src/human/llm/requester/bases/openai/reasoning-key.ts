import type { StreamedMessagePart, ThinkPart } from '#/llm/message';

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

export class ReasoningKeyDialect {
  private _detected: string | undefined;

  constructor(private readonly _explicitKey?: string) {}

  observe(source: unknown): string | undefined {
    const found = extractReasoning(source, this._explicitKey);
    if (found === undefined) return undefined;
    if (this._explicitKey === undefined) {
      this._detected = found.key;
    }
    return found.value;
  }

  outboundKey(): string {
    return this._explicitKey ?? this._detected ?? DEFAULT_REASONING_KEY;
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
): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];
  for (const element of elements) {
    if (element.type !== 'encrypted' && element.summary !== undefined && element.summary.length > 0) {
      parts.push({ type: 'think', think: element.summary, detailsIndex: element.index } satisfies ThinkPart);
    }
    if (element.type !== 'summary' && element.encrypted !== undefined && element.encrypted.length > 0) {
      parts.push({
        type: 'think',
        think: '',
        encrypted: element.encrypted,
        detailsIndex: element.index,
      } satisfies ThinkPart);
    }
  }
  return parts;
}
