// packages/app-core/src/lib/cronHumanize.ts

/**
 * Collapse a cron prompt for the notice card: keep only the first line, and if
 * that line itself exceeds `limit`, slice it with an ellipsis. `hasMore` tells
 * the caller whether to render the expand toggle (a newline or over-long text).
 * Without the length slice, a long one-line prompt would render in full even in
 * the "collapsed" state and make the toggle a no-op.
 */
export function collapsePrompt(
  text: string,
  limit = 120,
): { text: string; hasMore: boolean } {
  const firstLine = text.split('\n')[0] ?? '';
  const hasMore = text.includes('\n') || text.length > limit;
  const collapsed =
    firstLine.length > limit ? `${firstLine.slice(0, limit).trimEnd()}…` : firstLine;
  return { text: collapsed, hasMore };
}
