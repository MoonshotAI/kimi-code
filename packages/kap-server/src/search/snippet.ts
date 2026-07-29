/**
 * `search` module — hit snippet generation (pure function).
 *
 * minidb's text index scores documents but cannot locate the match inside the
 * text, so the snippet is produced here: a ~`radius`-char window around the
 * first occurrence of any query term (case-insensitive), whitespace-collapsed,
 * with ellipses marking truncation. Highlighting is left to clients.
 */

function collapseWs(s: string): string {
  return s.replaceAll(/\s+/g, ' ').trim();
}

/** Query terms for locating: whitespace-split words plus the whole query. */
export function snippetTerms(query: string): string[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const whole = query.trim();
  if (whole.length > 0 && !terms.includes(whole)) terms.push(whole);
  return terms;
}

/**
 * `anchor` — a caller-known hit location (`at` = offset of the match in
 * `text`, `len` = match length in code units), e.g. the confirmation offset
 * from literal search. When given, the term-guessing pass is skipped. The
 * window math clamps out-of-range offsets, so an anchor taken from a
 * normalized copy of the text (NFKC can shift offsets) degrades to a
 * slightly shifted window, never an error.
 */
export function makeSnippet(
  text: string,
  query: string,
  radius = 80,
  anchor?: { at: number; len: number },
): string {
  let hitAt = -1;
  let hitLen = 0;
  if (anchor !== undefined) {
    hitAt = anchor.at;
    hitLen = anchor.len;
  } else {
    const lower = text.toLowerCase();
    // Earliest occurrence across all terms wins; on ties prefer the longer term.
    for (const term of snippetTerms(query)) {
      const i = lower.indexOf(term.toLowerCase());
      if (i === -1) continue;
      if (hitAt === -1 || i < hitAt || (i === hitAt && term.length > hitLen)) {
        hitAt = i;
        hitLen = term.length;
      }
    }
  }

  if (hitAt === -1) {
    const head = collapseWs(text.slice(0, radius * 2));
    return text.length > radius * 2 ? `${head}…` : head;
  }

  const start = Math.max(0, hitAt - radius);
  const end = Math.min(text.length, hitAt + hitLen + radius);
  const window = collapseWs(text.slice(start, end));
  return `${start > 0 ? '…' : ''}${window}${end < text.length ? '…' : ''}`;
}
