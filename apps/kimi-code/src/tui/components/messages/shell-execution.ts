import type { Component } from '@moonshot-ai/pi-tui';
import { Container, Text } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import type { ResultRenderer } from './tool-renderers/types';
import { PREVIEW_LINES } from './tool-renderers/types';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

export interface ShellExecutionOptions {
  readonly command?: string;
  readonly result?: ToolResultBlockData;
  readonly expanded?: boolean;
  readonly showCommand?: boolean;
  /**
   * Max command lines to render. `undefined` means no cap — used by the
   * ctrl+o expanded view so the user can see the full multi-line command
   * even when the header preview was truncated.
   */
  readonly commandPreviewLines?: number;
  readonly resultPreviewLines?: number;
  readonly tailOutput?: boolean;
  readonly expandHint?: boolean;
}

export class ShellExecutionComponent extends Container {
  constructor(options: ShellExecutionOptions) {
    super();

    if (options.showCommand === true) {
      this.addCommandPreview(options.command ?? '', options.commandPreviewLines);
    }

    if (options.result !== undefined) {
      this.addResultPreview(
        options.result,
        options.expanded ?? false,
        options.resultPreviewLines ?? PREVIEW_LINES,
        options.tailOutput ?? false,
        options.expandHint ?? true,
      );
    }
  }

  private addCommandPreview(command: string, previewLines: number | undefined): void {
    if (command.length === 0) return;
    const allLines = command.split('\n');
    const lines = previewLines === undefined ? allLines : allLines.slice(0, previewLines);
    for (const [i, line] of lines.entries()) {
      // Distinguish the command (input) from the result (output): the `$`
      // prompt uses the dedicated shell-mode hue, the command body uses
      // `textDim`, and the result below is rendered one step dimmer in
      // `textMuted` so the two stay separable without a connecting glyph.
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
    previewLines: number,
    tailOutput: boolean,
    expandHint: boolean,
  ): void {
    if (!result.output) return;
    this.addChild(
      new TruncatedOutputComponent(result.output, {
        expanded,
        isError: result.is_error ?? false,
        maxLines: previewLines,
        tail: tailOutput,
        expandHint,
        color: 'textMuted',
      }),
    );
  }
}

export const shellExecutionResultRenderer: ResultRenderer = (
  _toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx,
): Component[] => [
  // Result only. The command preview is owned by ToolCallComponent's
  // buildCallPreview across the whole lifecycle (streaming, running, and
  // done); rendering it here too would duplicate the command once the result
  // lands.
  new ShellExecutionComponent({
    result,
    expanded: ctx.expanded,
  }),
];
