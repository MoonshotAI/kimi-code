import {
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  Text,
  textRenderLine,
  truncateToWidth,
  withRenderLineSelectionExclusions,
  type Component,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

import { IndentedText } from '../indented-text';
import type { TranscriptRowParts } from '../transcript-row-layout';
import { outcomeRows } from './outcome';
import { splitToolTranscriptRow, toolTranscriptGutterWidths } from './transcript-row';
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
  private readonly fixedLeftIndent: boolean;
  private readonly expandHint: boolean;
  private readonly tail: boolean;
  private truncatedAtLastRender = false;
  private renderCache: { width: number; source: TuiRenderLine[]; lines: TuiRenderLine[] } | undefined;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      maxLines?: number;
      indent?: number;
      indentLayout?: 'responsive' | 'fixed-left';
      expandHint?: boolean;
      tail?: boolean;
      color?: keyof ColorPalette;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.indent = options.indent ?? DEFAULT_INDENT;
    this.fixedLeftIndent = options.indentLayout === 'fixed-left';
    this.expandHint = options.expandHint ?? true;
    this.tail = options.tail ?? false;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    const successColor = options.color ?? 'textDim';
    const colored = options.isError
      ? currentTheme.fg('error', cleaned)
      : currentTheme.fg(successColor, cleaned);
    this.textComponent = this.fixedLeftIndent
      ? new IndentedText(colored, ' '.repeat(this.indent))
      : new Text(colored, this.indent, 0);
  }

  invalidate(): void {
    this.renderCache = undefined;
    this.textComponent.invalidate();
  }

  private indentWidth(width: number): number {
    const available = this.fixedLeftIndent ? Math.max(0, width - 1) : Math.max(0, width);
    return Math.min(this.indent, available);
  }

  private renderHint(width: number, hint: string): string {
    const indentWidth = this.indentWidth(width);
    const hintWidth = Math.max(0, width - indentWidth);
    return ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…'));
  }

  wasTruncated(): boolean {
    return this.truncatedAtLastRender;
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    const contentLines = renderComponentLines(this.textComponent, width);
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

  renderTranscriptRow(width: number): TranscriptRowParts {
    const lines = renderComponentLines(this, width);
    return splitToolTranscriptRow(this, lines, width, toolTranscriptGutterWidths(lines));
  }

  private collapse(width: number, contentLines: TuiRenderLine[]): TuiRenderLine[] {
    const remaining = contentLines.length - this.maxLines;
    const hint = this.tail
      ? `… (${String(remaining)} earlier lines)`
      : this.expandHint
        ? `… (${String(remaining)} more lines, ctrl+o to expand)`
        : `… (${String(remaining)} more lines)`;
    const hintLine = withRenderLineSelectionExclusions(
      textRenderLine(this.renderHint(width, hint)),
      [{ start: 0, end: this.indentWidth(width) }],
    );
    const shown = this.tail
      ? contentLines.slice(contentLines.length - this.maxLines)
      : contentLines.slice(0, this.maxLines);
    return this.tail ? [hintLine, ...shown] : [...shown, hintLine];
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
