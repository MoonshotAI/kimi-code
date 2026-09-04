/**
 * The collapsed card's outcome rows: dim, width-truncated lines under the
 * header that state what came of the call. Output short enough to fit
 * (`OUTCOME_MAX_LINES`) is shown whole; longer output contributes one telling
 * line — a command's last line, an MCP tool's first line — marked with an
 * ellipsis on the side it was cut from, and the rest waits for ctrl+o. Cards
 * without any output stay single-row.
 */

import type { Component } from '@moonshot-ai/pi-tui';

import { OUTCOME_MAX_LINES, OUTCOME_ROW_INDENT, TRUNCATION_ELLIPSIS } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

import { TruncatedHeaderLine } from '../truncated-header-line';

// One shared reference so the line's render cache survives rebuilds (segment
// styles are compared by identity); the palette is read at call time.
const dimOutcomeStyle = (text: string): string => currentTheme.dim(text);

export function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.trimEnd());
}

/** One outcome row with a custom fixed tail (the Grep glance's `, +N more`). */
export function outcomeRow(head: string, text: string, tail: string): Component {
  return new TruncatedHeaderLine({
    head,
    flex: { text, style: dimOutcomeStyle, keep: 'head' },
    tail: tail.length > 0 ? dimOutcomeStyle(tail) : '',
  });
}

/**
 * One outcome row. `more` marks hidden output with an ellipsis on the side it
 * was cut from — `above` when this is the last line of a longer output,
 * `below` when it is the first. The marker lives in the fixed head/tail so a
 * width cut never eats it.
 */
export function outcomeLine(text: string, more?: 'above' | 'below'): Component {
  return outcomeRow(
    more === 'above' ? `${OUTCOME_ROW_INDENT}${TRUNCATION_ELLIPSIS} ` : OUTCOME_ROW_INDENT,
    text,
    more === 'below' ? ` ${TRUNCATION_ELLIPSIS}` : '',
  );
}

/**
 * Rows for a finished call's output: every line when there are at most
 * `OUTCOME_MAX_LINES`, otherwise the one line named by `keep`.
 */
export function outcomeRows(output: string, keep: 'first' | 'last'): Component[] {
  const lines = nonEmptyLines(output);
  if (lines.length <= OUTCOME_MAX_LINES) return lines.map((line) => outcomeLine(line));
  const line = keep === 'first' ? lines[0] : lines.at(-1);
  return line === undefined ? [] : [outcomeLine(line, keep === 'first' ? 'below' : 'above')];
}
