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

export function steerEventParts(input: unknown): { readonly texts: readonly string[]; readonly hasMedia: boolean } {
  if (typeof input === 'string') {
    return { texts: input.length > 0 ? [input] : [], hasMedia: false };
  }
  if (!Array.isArray(input)) return { texts: [], hasMedia: false };
  const texts: string[] = [];
  let hasMedia = false;
  for (const part of input) {
    if (part === null || typeof part !== 'object') continue;
    if (!('type' in part) || typeof part.type !== 'string') continue;
    if (part.type !== 'text') {
      hasMedia = true;
      continue;
    }
    if (hasSource(part)) continue;
    if (!('text' in part) || typeof part.text !== 'string' || part.text.length === 0) continue;
    texts.push(part.text);
  }
  return { texts, hasMedia };
}

function hasSource(part: object): boolean {
  if (!('meta' in part) || part.meta === null || typeof part.meta !== 'object') return false;
  return 'source' in part.meta && part.meta.source !== undefined;
}

export function steerMatchTexts(texts: readonly string[]): readonly string[] {
  if (texts.length <= 1) return texts;
  return [texts.join(''), ...texts];
}

export function isTurnSteerEvent(
  event: object,
): event is {
  readonly type: 'turn.steer';
  readonly input?: unknown;
  readonly promptIds?: readonly string[];
  readonly origin?: unknown;
} {
  return 'type' in event && event.type === 'turn.steer';
}

export function isTurnPromptEvent(
  event: object,
): event is {
  readonly type: 'turn.prompt';
  readonly input?: unknown;
  readonly promptId?: string;
  readonly origin?: unknown;
} {
  return 'type' in event && event.type === 'turn.prompt';
}

export function isUserSteerOrigin(event: { readonly origin?: unknown }): boolean {
  if (event.origin === undefined) return true;
  if (event.origin === null || typeof event.origin !== 'object') return false;
  return 'kind' in event.origin && event.origin.kind === 'user';
}

export function isInTurnUserOrigin(origin: unknown): boolean {
  if (origin === null || typeof origin !== 'object') return false;
  return 'kind' in origin && origin.kind === 'user' && 'inTurn' in origin && origin.inTurn === true;
}

// A shorter pending steer must not match inside a different message.
// Skill activation text is prepended and ends at `</skill-loaded>`, so the
// submitted user text is also a suffix immediately after `>`.
function boundaryIndex(eventText: string, batchText: string): number {
  if (batchText.length === 0) return -1;
  if (eventText === batchText) return 0;
  let from = 0;
  while (from <= eventText.length) {
    const index = eventText.indexOf(batchText, from);
    if (index < 0) return -1;
    const end = index + batchText.length;
    const beforeOk =
      index === 0 || eventText.startsWith('\n\n', index - 2) || eventText[index - 1] === '>';
    const afterOk = end === eventText.length || eventText.startsWith('\n\n', end);
    if (beforeOk && afterOk) return index;
    from = index + 1;
  }
  return -1;
}

export function takeDeliveredSteerBatches<B extends SteerDeliveryBatch<unknown>>(
  batches: readonly B[],
  eventText: string,
): { readonly delivered: B[]; readonly pending: B[] } {
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
  const delivered: B[] = [];
  const pending: B[] = [];
  batches.forEach((batch, index) => {
    if (deliveredIndexes.has(index)) delivered.push(batch);
    else pending.push(batch);
  });
  return { delivered, pending };
}
