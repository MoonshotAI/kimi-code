import type { Component } from '@moonshot-ai/pi-tui';
import { Container, Text } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

import type { ResultRenderer } from './tool-renderers/types';
import { isSpilledToolOutput, PREVIEW_LINES } from './tool-renderers/types';
import { outcomeRows } from './tool-renderers/outcome';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

export interface ShellExecutionOptions {
  readonly command?: string;
  readonly result?: ToolResultBlockData;
  readonly expanded?: boolean;
  readonly showCommand?: boolean;
  readonly commandPreviewLines?: number;
  readonly expandHint?: boolean;
}

export class ShellExecutionComponent extends Container {
  private renderCache:
    | { width: number; lines: string[]; childRefs: Component[]; childLines: (readonly string[])[] }
    | undefined;

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
    const cache = this.renderCache;
    const childRefs = this.children;
    const childLines = childRefs.map((child) => child.render(width));
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

  private addCommandPreview(command: string, previewLines: number | undefined): void {
    if (command.length === 0) return;
    const allLines = command.split('\n');
    const lines = previewLines === undefined ? allLines : allLines.slice(0, previewLines);
    for (const [i, line] of lines.entries()) {
      const text =
        i === 0
          ? currentTheme.fg('shellMode', '$ ') + currentTheme.dim(line)
          : `  ${currentTheme.dim(line)}`;
      this.addChild(new Text(text, 2, 0));
    }
  }

  private addResultPreview(
    result: ToolResultBlockData,
    expanded: boolean,
    expandHint: boolean,
  ): void {
    if (!result.output) return;
    this.addChild(
      new TruncatedOutputComponent(sanitizeShellOutput(result.output), {
        expanded,
        isError: result.is_error ?? false,
        maxLines: PREVIEW_LINES,
        expandHint,
        color: 'textMuted',
      }),
    );
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
