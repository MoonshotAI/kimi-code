/**
 * abbreviatePath — shorten a "/"-separated path to fit a column budget while
 * keeping it recognizable.
 *
 * Degradation tiers (the count of `…` stays accurate until space is tight):
 *  1. Fits → returned unchanged.
 *  2. Keep the most leading + trailing *full* segments that fit; each elided
 *     middle segment becomes its own `…`
 *     (e.g. `this/is/…/…/…/…/…/…/omitted/right.md`).
 *  3. When even one full segment per side is too wide, abbreviate the end
 *     segments themselves, preserving a file extension (`th…/…/ri….md`).
 *  4. When the middle run is long (or space is very small) the run of `…`
 *     collapses to a single `……` token.
 *
 * Pure and width-aware (measured with `visibleWidth`); see the unit tests for
 * the pinned visual contract.
 */

import { visibleWidth } from '@earendil-works/pi-tui';

const ELLIPSIS = '…';
/** Marks a collapsed run of several omitted segments. */
const ELLIPSIS_RUN = '……';
/** Beyond this many omitted segments the per-segment `…` run collapses to `……`. */
const MAX_ELLIPSIS_RUN = 6;

export function abbreviatePath(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(path) <= maxWidth) return path;

  const segments = path.split('/');
  const n = segments.length;
  if (n === 1) return truncateSegment(segments[0] ?? '', maxWidth);

  // Tier 2: keep the widest leading+trailing block of full segments that fits.
  // Higher k = more real context and wider, so the first fit from the top is
  // the most informative rendering that still fits.
  for (let k = n - 1; k >= 2; k--) {
    const tail = Math.ceil(k / 2); // favor the trailing side (the file name)
    const head = k - tail;
    const candidate = [
      ...segments.slice(0, head),
      ...middleRun(n - head - tail),
      ...segments.slice(n - tail),
    ].join('/');
    if (visibleWidth(candidate) <= maxWidth) return candidate;
  }

  // Tier 3/4: even one full segment per side is too wide — abbreviate the ends.
  const middle = middleRun(n - 2);
  const sepWidth = middle.length === 0 ? 1 : visibleWidth(middle.join('/')) + 2;
  const budget = maxWidth - sepWidth;
  if (budget >= 2) {
    // The trailing segment (the file name) carries the most meaning, so give it
    // as much room as it needs — up to its full width — and leave the rest for
    // the leading segment. This keeps a file extension whenever it can fit.
    const lastBudget = Math.min(visibleWidth(segments[n - 1] ?? ''), Math.max(1, budget - 2));
    const firstBudget = budget - lastBudget;
    const last = truncateSegment(segments[n - 1] ?? '', lastBudget);
    const first = firstBudget >= 1 ? truncateSegment(segments[0] ?? '', firstBudget) : ELLIPSIS;
    const candidate = (middle.length === 0 ? [first, last] : [first, ...middle, last]).join('/');
    if (visibleWidth(candidate) <= maxWidth) return candidate;
  }

  // Last resort: treat the whole path as one segment and middle-truncate it.
  return truncateSegment(path, maxWidth);
}

/**
 * Clip plain text to `width`, appending `…` when truncated. Unlike pi-tui's
 * `truncateToWidth` with an ellipsis marker, the result carries NO ANSI reset
 * codes, so the caller can color the whole string (including the ellipsis)
 * without the reset breaking the color mid-string.
 */
export function clipToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return ELLIPSIS;
  return `${clipPlain(text, width - 1)}${ELLIPSIS}`;
}

/** A run of omitted segments: one `…` each, collapsing to `……` when long. */
function middleRun(count: number): string[] {
  if (count <= 0) return [];
  if (count > MAX_ELLIPSIS_RUN) return [ELLIPSIS_RUN];
  return Array.from({ length: count }, () => ELLIPSIS);
}

/** Middle-truncate a single segment to `width`, keeping a file extension. */
function truncateSegment(segment: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(segment) <= width) return segment;
  if (width === 1) return ELLIPSIS;
  const dot = segment.lastIndexOf('.');
  const ext = dot > 0 ? segment.slice(dot) : '';
  if (ext.length > 0 && visibleWidth(ext) + 1 < width) {
    return `${clipPlain(segment, width - 1 - visibleWidth(ext))}${ELLIPSIS}${ext}`;
  }
  return `${clipPlain(segment, width - 1)}${ELLIPSIS}`;
}

/** Hard-cut text to `width` columns. Pure: no ellipsis and no ANSI codes. */
function clipPlain(text: string, width: number): string {
  if (width <= 0) return '';
  let out = '';
  let used = 0;
  for (const char of Array.from(text)) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > width) break;
    out += char;
    used += charWidth;
  }
  return out;
}
