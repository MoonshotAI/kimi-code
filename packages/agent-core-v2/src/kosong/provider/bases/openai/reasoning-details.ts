import type { StreamedMessagePart, ThinkPart } from '#/kosong/contract/message';

export const REASONING_DETAILS_KEY = 'reasoning_details';

export function extractReasoningDetails(source: unknown): readonly unknown[] | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[REASONING_DETAILS_KEY];
  return Array.isArray(value) ? value : undefined;
}

export function convertReasoningDetails(
  elements: readonly unknown[],
): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];
  for (const [position, element] of elements.entries()) {
    if (typeof element !== 'object' || element === null) continue;
    const record = element as Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? record['type'] : undefined;
    if (type !== undefined && type !== 'summary' && type !== 'encrypted') continue;
    const index = typeof record['index'] === 'number' ? record['index'] : position;
    const summary = record['summary'];
    const encrypted = record['encrypted'];
    if (type !== 'encrypted' && typeof summary === 'string' && summary.length > 0) {
      parts.push({ type: 'think', think: summary, detailsIndex: index } satisfies ThinkPart);
    }
    if (type !== 'summary' && typeof encrypted === 'string' && encrypted.length > 0) {
      parts.push({
        type: 'think',
        think: '',
        encrypted,
        detailsIndex: index,
      } satisfies ThinkPart);
    }
  }
  return parts;
}
