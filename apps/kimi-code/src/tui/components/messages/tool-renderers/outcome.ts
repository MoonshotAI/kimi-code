/**
 * The collapsed card's second row: one dim, width-truncated line that states
 * the outcome of the call — a command's last output line, a Grep glance, an
 * MCP tool's first line. Cards without a telling line stay single-row.
 */

import type { Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

import { TruncatedHeaderLine } from '../truncated-header-line';

const OUTCOME_INDENT = '  ';

// One shared reference so the line's render cache survives rebuilds (segment
// styles are compared by identity); the palette is read at call time.
const dimOutcomeStyle = (text: string): string => currentTheme.dim(text);

export function firstNonEmptyLine(text: string): string | undefined {
  return text.split('\n').find((line) => line.trim().length > 0)?.trimEnd();
}

export function lastNonEmptyLine(text: string): string | undefined {
  return text
    .split('\n')
    .findLast((line) => line.trim().length > 0)
    ?.trimEnd();
}

export function outcomeLine(text: string): Component {
  return new TruncatedHeaderLine({
    head: OUTCOME_INDENT,
    flex: { text, style: dimOutcomeStyle, keep: 'head' },
    tail: '',
  });
}
