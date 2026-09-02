export interface MentionMatchSpan {
  text: string;
  hit: boolean;
}

/**
 * Split `text` into hit/plain runs from match positions. `positions` index
 * into the full path; `start` shifts them into this text's frame.
 */
export function mentionMatchSpans(
  text: string,
  positions: readonly number[] | undefined,
  start: number,
): MentionMatchSpan[] {
  if (positions === undefined || positions.length === 0 || text.length === 0) {
    return [{ text, hit: false }];
  }
  const hits = new Set<number>();
  for (const pos of positions) {
    const i = pos - start;
    if (i >= 0 && i < text.length) hits.add(i);
  }
  if (hits.size === 0) return [{ text, hit: false }];
  const spans: MentionMatchSpan[] = [];
  let runStart = 0;
  let runHit = hits.has(0);
  for (let i = 1; i < text.length; i++) {
    const hit = hits.has(i);
    if (hit !== runHit) {
      spans.push({ text: text.slice(runStart, i), hit: runHit });
      runStart = i;
      runHit = hit;
    }
  }
  spans.push({ text: text.slice(runStart), hit: runHit });
  return spans;
}
