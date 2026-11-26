import { Text, truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

import { outcomeRows } from './outcome';
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

export class TruncatedOutputComponent implements Component {
  private textComponent: Text;
  private readonly expanded: boolean;
  private readonly maxLines: number;
  private readonly indent: number;
  private readonly expandHint: boolean;
  private readonly tail: boolean;
  private truncatedAtLastRender = false;
  private renderCache: { width: number; source: readonly string[]; lines: string[] } | undefined;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      maxLines?: number;
      indent?: number;
      expandHint?: boolean;
      tail?: boolean;
      color?: keyof ColorPalette;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.indent = options.indent ?? DEFAULT_INDENT;
    this.expandHint = options.expandHint ?? true;
    this.tail = options.tail ?? false;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    const successColor = options.color ?? 'textDim';
    this.textComponent = new Text(
      options.isError ? currentTheme.fg('error', cleaned) : currentTheme.fg(successColor, cleaned),
      this.indent,
      0,
    );
  }

  invalidate(): void {
    this.renderCache = undefined;
    this.textComponent.invalidate();
  }

  private renderHint(width: number, hint: string): string {
    const indentWidth = Math.min(this.indent, Math.max(0, width));
    const hintWidth = Math.max(0, width - indentWidth);
    return ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…'));
  }

  wasTruncated(): boolean {
    return this.truncatedAtLastRender;
  }

  render(width: number): readonly string[] {
    const contentLines = this.textComponent.render(width);
    this.truncatedAtLastRender = contentLines.length > this.maxLines + 1;

    if (this.expanded || contentLines.length <= this.maxLines + 1) {
      return contentLines;
    }

    if (isRenderCacheEnabled() && this.renderCache?.width === width && this.renderCache.source === contentLines) {
      return this.renderCache.lines;
    }

    const lines = this.collapse(width, contentLines);
    if (isRenderCacheEnabled()) this.renderCache = { width, source: contentLines, lines };
    return lines;
  }

  private collapse(width: number, contentLines: readonly string[]): string[] {
    const remaining = contentLines.length - this.maxLines;
    if (this.tail) {
      const shown = contentLines.slice(contentLines.length - this.maxLines);
      return [
        this.renderHint(width, `… (${String(remaining)} earlier lines)`),
        ...shown,
      ];
    }

    const shown = contentLines.slice(0, this.maxLines);
    const hint = this.expandHint
      ? `… (${String(remaining)} more lines, ctrl+o to expand)`
      : `… (${String(remaining)} more lines)`;
    return [...shown, this.renderHint(width, hint)];
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  if (!ctx.expanded && result.is_error !== true) return outcomeRows(result.output, 'first');
  return [
    new TruncatedOutputComponent(result.output, {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
    }),
  ];
};
