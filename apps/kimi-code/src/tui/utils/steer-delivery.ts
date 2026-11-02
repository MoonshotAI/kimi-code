export interface SteerDeliveryBatch<T> {
  readonly text: string;
  readonly entries: readonly T[];
}

export function steerPayloadText(
  payload: string | readonly { readonly type: string; readonly text?: string }[],
): string {
  if (typeof payload === 'string') return payload;
  let text = '';
  for (const part of payload) {
    if (part.type === 'text' && part.text !== undefined) text += part.text;
  }
  return text;
}

export function steerEventText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  let text = '';
  for (const part of input) {
    if (part === null || typeof part !== 'object') continue;
    if (!('type' in part) || part.type !== 'text') continue;
    if (!('text' in part) || typeof part.text !== 'string') continue;
    text += part.text;
  }
  return text;
}

export function isTurnSteerEvent(
  event: object,
): event is { readonly type: 'turn.steer'; readonly input?: unknown } {
  return 'type' in event && event.type === 'turn.steer';
}

// A shorter pending steer must not match inside a different message.
// Only an exact text, or a segment split by the steer joiner, counts.
function boundaryIndex(eventText: string, batchText: string): number {
  if (batchText.length === 0) return -1;
  if (eventText === batchText) return 0;
  let from = 0;
  while (from <= eventText.length) {
    const index = eventText.indexOf(batchText, from);
    if (index < 0) return -1;
    const beforeOk = index === 0 || eventText.startsWith('\n\n', index - 2);
    const after = index + batchText.length;
    const afterOk = after === eventText.length || eventText.startsWith('\n\n', after);
    if (beforeOk && afterOk) return index;
    from = index + 1;
  }
  return -1;
}

export function takeDeliveredSteerBatches<T>(
  batches: readonly SteerDeliveryBatch<T>[],
  eventText: string,
): { readonly delivered: SteerDeliveryBatch<T>[]; readonly pending: SteerDeliveryBatch<T>[] } {
  if (eventText.length === 0) {
    return { delivered: [], pending: [...batches] };
  }
  const ranked = batches
    .map((batch, index) => ({ batch, index }))
    .filter((item) => item.batch.text.length > 0)
    .toSorted((a, b) => b.batch.text.length - a.batch.text.length || a.index - b.index);
  let rest = eventText;
  const deliveredIndexes = new Set<number>();
  for (const item of ranked) {
    const at = boundaryIndex(rest, item.batch.text);
    if (at < 0) continue;
    deliveredIndexes.add(item.index);
    rest = rest.slice(0, at) + rest.slice(at + item.batch.text.length);
  }
  const delivered: SteerDeliveryBatch<T>[] = [];
  const pending: SteerDeliveryBatch<T>[] = [];
  batches.forEach((batch, index) => {
    if (deliveredIndexes.has(index)) delivered.push(batch);
    else pending.push(batch);
  });
  return { delivered, pending };
}
