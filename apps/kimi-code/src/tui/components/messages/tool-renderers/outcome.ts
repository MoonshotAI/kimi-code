/**
 * The collapsed card's outcome rows: dim, width-truncated lines under the
 * header that state what came of the call. Output short enough to fit
 * (`OUTCOME_MAX_LINES`) is shown whole; longer output contributes one telling
 * line — a command's last line, an MCP tool's first line — and the rest waits
 * for ctrl+o. Cards without any output stay single-row.
 */

import type { Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

import { TruncatedHeaderLine } from '../truncated-header-line';

/** Non-empty output lines a collapsed card shows in full before it falls back to one. */
export const OUTCOME_MAX_LINES = 3;

const OUTCOME_INDENT = '  ';

// One shared reference so the line's render cache survives rebuilds (segment
// styles are compared by identity); the palette is read at call time.
const dimOutcomeStyle = (text: string): string => currentTheme.dim(text);

export function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.trimEnd());
}

export function lastNonEmptyLine(text: string): string | undefined {
  return nonEmptyLines(text).at(-1);
}

export function outcomeLine(text: string): Component {
  return new TruncatedHeaderLine({
    head: OUTCOME_INDENT,
    flex: { text, style: dimOutcomeStyle, keep: 'head' },
    tail: '',
  });
}

/**
 * Rows for a finished call's output: every line when there are at most
 * `OUTCOME_MAX_LINES`, otherwise the one line named by `keep`.
 */
export function outcomeRows(output: string, keep: 'first' | 'last'): Component[] {
  const lines = nonEmptyLines(output);
  if (lines.length <= OUTCOME_MAX_LINES) return lines.map((line) => outcomeLine(line));
  const line = keep === 'first' ? lines[0] : lines.at(-1);
  return line === undefined ? [] : [outcomeLine(line)];
}
