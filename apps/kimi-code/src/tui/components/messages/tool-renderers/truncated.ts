import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

import type { ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

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
  private textComponent: Text;
  private readonly expanded: boolean;
  private readonly maxLines: number;
  private readonly output: string;
  private readonly isError: boolean | undefined;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      maxLines?: number;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.output = output;
    this.isError = options.isError;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    this.textComponent = new Text(
      options.isError ? currentTheme.fg('error', cleaned) : currentTheme.dim(cleaned),
      2,
      0,
    );
  }

  invalidate(): void {
    const cleaned = trimTrailingEmptyLines(this.output.split('\n')).join('\n');
    this.textComponent.setText(
      this.isError ? currentTheme.fg('error', cleaned) : currentTheme.dim(cleaned),
    );
    this.textComponent.invalidate();
  }

  render(width: number): string[] {
    const contentLines = this.textComponent.render(width);

    if (this.expanded || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    const shown = contentLines.slice(0, this.maxLines);
    const remaining = contentLines.length - this.maxLines;
    return [
      ...shown,
      currentTheme.dim(`... (${String(remaining)} more lines, ctrl+o to expand)`),
    ];
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  return [
    new TruncatedOutputComponent(result.output, {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
    }),
  ];
};
