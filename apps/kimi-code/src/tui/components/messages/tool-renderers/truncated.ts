import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

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
  private textComponent: Text;
  private readonly expanded: boolean;
  private readonly maxLines: number;
  private readonly indent: number;
  private readonly expandHint: boolean;
  private readonly tail: boolean;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      maxLines?: number;
      indent?: number;
      // When false, the truncation footer omits the "ctrl+o to expand" promise
      // (for contexts whose output is fixed-truncated and never expands).
      expandHint?: boolean;
      // When true, collapsed rendering keeps the latest visual rows instead of
      // the first rows. This is useful for live output from a running command.
      tail?: boolean;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.indent = options.indent ?? DEFAULT_INDENT;
    this.expandHint = options.expandHint ?? true;
    this.tail = options.tail ?? false;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    this.textComponent = new Text(
      options.isError ? currentTheme.fg('error', cleaned) : currentTheme.dim(cleaned),
      this.indent,
      0,
    );
  }

  invalidate(): void {
    // Text component caches wrapped lines; invalidate on terminal resize.
    this.textComponent.invalidate();
  }

  render(width: number): string[] {
    const contentLines = this.textComponent.render(width);

    if (this.expanded || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    const remaining = contentLines.length - this.maxLines;
    if (this.tail) {
      const shown = contentLines.slice(contentLines.length - this.maxLines);
      return [
        ' '.repeat(this.indent) + currentTheme.dim(`... (${String(remaining)} earlier lines)`),
        ...shown,
      ];
    }

    const shown = contentLines.slice(0, this.maxLines);
    const hint = this.expandHint
      ? `... (${String(remaining)} more lines, ctrl+o to expand)`
      : `... (${String(remaining)} more lines)`;
    return [...shown, ' '.repeat(this.indent) + currentTheme.dim(hint)];
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
