import type { Component, TuiRenderLine } from '@moonshot-ai/pi-tui';
import {
  Container,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  Text,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

import { splitToolTranscriptRow } from './tool-renderers/transcript-row';
import type { ResultRenderer } from './tool-renderers/types';
import { isSpilledToolOutput, PREVIEW_LINES } from './tool-renderers/types';
import { outcomeRows } from './tool-renderers/outcome';
import { TruncatedOutputComponent } from './tool-renderers/truncated';
import type { TranscriptRowParts } from './transcript-row-layout';

export interface ShellExecutionOptions {
  readonly command?: string;
  readonly result?: ToolResultBlockData;
  readonly expanded?: boolean;
  readonly showCommand?: boolean;
  readonly commandPreviewLines?: number;
  readonly expandHint?: boolean;
}

interface TranscriptChild {
  readonly component: Component;
  readonly promptWidth: number;
}

export class ShellExecutionComponent extends Container {
  private renderCache:
    | { width: number; lines: TuiRenderLine[]; childRefs: Component[]; childLines: TuiRenderLine[][] }
    | undefined;
  private readonly transcriptChildren: TranscriptChild[] = [];

  constructor(options: ShellExecutionOptions) {
    super();

    if (options.showCommand === true) {
      this.addCommandPreview(options.command ?? '', options.commandPreviewLines);
    }

    if (options.result !== undefined) {
      this.addResultPreview(options.result, options.expanded ?? false, options.expandHint ?? true);
    }
  }

  override invalidate(): void {
    this.renderCache = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  override [RENDER_LINES](width: number): TuiRenderLine[] {
    const cache = this.renderCache;
    const childRefs = this.children;
    const childLines = childRefs.map((child) => renderComponentLines(child, width));
    if (
      isRenderCacheEnabled() &&
      cache?.width === width &&
      cache.childRefs.length === childRefs.length &&
      cache.childRefs.every(
        (child, index) => child === childRefs[index] && cache.childLines[index] === childLines[index],
      )
    ) {
      return cache.lines;
    }
    const lines = childLines.flat();
    if (isRenderCacheEnabled()) this.renderCache = { width, lines, childRefs: [...childRefs], childLines };
    return lines;
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    const safeWidth = Math.max(1, width);
    const source: TuiRenderLine[] = [];
    const gutterWidths: number[] = [];
    for (const child of this.transcriptChildren) {
      const lines = renderComponentLines(child.component, safeWidth);
      lines.forEach((line, index) => {
        source.push(line);
        const padding = line.selectionExclusions?.find((range) => range.start === 0)?.end ?? 0;
        gutterWidths.push(padding + (index === 0 ? child.promptWidth : 0));
      });
    }
    return splitToolTranscriptRow(this, source, safeWidth, gutterWidths);
  }

  private addCommandPreview(command: string, previewLines: number | undefined): void {
    if (command.length === 0) return;
    const allLines = command.split('\n');
    const lines = previewLines === undefined ? allLines : allLines.slice(0, previewLines);
    for (const [i, line] of lines.entries()) {
      const text =
        i === 0
          ? currentTheme.fg('shellMode', '$ ') + currentTheme.dim(line)
          : `  ${currentTheme.dim(line)}`;
      const component = new Text(text, 2, 0);
      this.addChild(component);
      this.transcriptChildren.push({ component, promptWidth: 2 });
    }
  }

  private addResultPreview(
    result: ToolResultBlockData,
    expanded: boolean,
    expandHint: boolean,
  ): void {
    if (!result.output) return;
    const component = new TruncatedOutputComponent(sanitizeShellOutput(result.output), {
      expanded,
      isError: result.is_error ?? false,
      maxLines: PREVIEW_LINES,
      expandHint,
      color: 'textMuted',
    });
    this.addChild(component);
    this.transcriptChildren.push({ component, promptWidth: 0 });
  }

  wasTruncated(): boolean {
    return this.children.some(
      (child) => child instanceof TruncatedOutputComponent && child.wasTruncated(),
    );
  }
}

export const shellExecutionResultRenderer: ResultRenderer = (
  _toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx,
): Component[] => {
  if (!ctx.expanded && result.is_error !== true) {
    const leadsWithMetadata =
      result.output.startsWith('task_id:') || isSpilledToolOutput(result.output);
    return outcomeRows(result.output, leadsWithMetadata ? 'first' : 'last');
  }
  return [
    new ShellExecutionComponent({
      result,
      expanded: ctx.expanded,
    }),
  ];
};
