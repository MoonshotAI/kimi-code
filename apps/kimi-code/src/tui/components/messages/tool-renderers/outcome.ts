import type { Component } from '@moonshot-ai/pi-tui';

import { OUTCOME_MAX_LINES, OUTCOME_ROW_INDENT, TRUNCATION_ELLIPSIS } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

import { TruncatedHeaderLine } from '../truncated-header-line';
import { stripSpillPointer } from './types';

const dimOutcomeStyle = (text: string): string => currentTheme.dim(text);

export function nonEmptyLines(text: string): string[] {
  return sanitizeShellOutput(stripSpillPointer(text))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.trimEnd());
}

export function outcomeRow(head: string, text: string, tail: string): Component {
  return new TruncatedHeaderLine({
    head,
    flex: { text, style: dimOutcomeStyle, keep: 'head' },
    tail: tail.length > 0 ? dimOutcomeStyle(tail) : '',
  });
}

export function outcomeLine(text: string, more?: 'above' | 'below'): Component {
  return outcomeRow(
    more === 'above' ? `${OUTCOME_ROW_INDENT}${TRUNCATION_ELLIPSIS} ` : OUTCOME_ROW_INDENT,
    text,
    more === 'below' ? ` ${TRUNCATION_ELLIPSIS}` : '',
  );
}

export function outcomeRows(output: string, keep: 'first' | 'last'): Component[] {
  const lines = nonEmptyLines(output);
  if (lines.length <= OUTCOME_MAX_LINES) return lines.map((line) => outcomeLine(line));
  const line = keep === 'first' ? lines[0] : lines.at(-1);
  return line === undefined ? [] : [outcomeLine(line, keep === 'first' ? 'below' : 'above')];
}
