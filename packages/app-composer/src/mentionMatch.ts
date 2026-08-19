/**
 * Match highlighting for the @-mention menu rows.
 *
 * The daemon's fs:search/fs:suggest answers carry `match_positions` — indexes
 * of the matched characters into the candidate's FULL workspace-relative path
 * (not the basename). A menu row renders that path as two labels: the name
 * (basename) and the containing directory. This helper splits either label
 * into plain/highlighted runs, translating the full-path positions into the
 * label's own coordinate space.
 */

/** One run of a row label: plain text, or a matched (highlighted) hit. */
export interface MentionMatchSpan {
  text: string;
  hit: boolean;
}

/**
 * Split `text` into plain/hit runs.
 *
 * `positions` indexes into the full path; `start` is the offset of `text`
 * within that path (0 for the directory label, `path.length - name.length`
 * for the name). Positions outside the covered range are ignored. When
 * nothing inside the range matched (or there are no positions at all — e.g.
 * the bare-`@` root listing) the result is a single plain span, so the caller
 * can render uniformly.
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
