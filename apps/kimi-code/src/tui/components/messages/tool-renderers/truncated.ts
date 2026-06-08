import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

import type { ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

const DEFAULT_INDENT = 2;

export function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.length > 0) break;
    end--;
  }
  return lines.slice(0, end);
}

/**
 * Component that renders tool output with wrap-aware line truncation.
 * Uses pi-tui's Text component to compute actual visual wrapped lines,
 * then caps at PREVIEW_LINES. This handles long single-line output (e.g.
 * JSON blobs) that would otherwise wrap to dozens of visual rows.
 */
export class TruncatedOutputComponent implements Component {
  private readonly textComponent: Text;
  private readonly expanded: boolean;
  private readonly maxLines: number;
  private readonly indent: number;
  private readonly expandHint: boolean;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      colors: ColorPalette;
      maxLines?: number;
      indent?: number;
      // When false, the truncation footer omits the "ctrl+o to expand" promise
      // (for contexts whose output is fixed-truncated and never expands).
      expandHint?: boolean;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.indent = options.indent ?? DEFAULT_INDENT;
    this.expandHint = options.expandHint ?? true;
    const tint = options.isError ? chalk.hex(options.colors.error) : chalk.dim;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    this.textComponent = new Text(tint(cleaned), this.indent, 0);
  }

  invalidate(): void {
    this.textComponent.invalidate();
  }

  render(width: number): string[] {
    const contentLines = this.textComponent.render(width);

    if (this.expanded || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    const shown = contentLines.slice(0, this.maxLines);
    const remaining = contentLines.length - this.maxLines;
    const hint = this.expandHint
      ? `... (${String(remaining)} more lines, ctrl+o to expand)`
      : `... (${String(remaining)} more lines)`;
    return [...shown, ' '.repeat(this.indent) + chalk.dim(hint)];
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  return [
    new TruncatedOutputComponent(result.output, {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
      colors: ctx.colors,
    }),
  ];
};
