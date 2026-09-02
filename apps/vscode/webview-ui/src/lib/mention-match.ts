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
  for (const i of [...hits]) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) hits.add(i + 1);
    } else if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const prev = text.charCodeAt(i - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) hits.add(i - 1);
    }
  }
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
