/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 */

import type { Component, TUI } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MESSAGE_INDENT,
  RESULT_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

export type ThinkingRenderMode = 'live' | 'finalized';

export class ThinkingComponent implements Component {
  private text: string;
  private color: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private expanded = false;
  private readonly ui: TUI | undefined;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;

  constructor(
    text: string,
    colors: ColorPalette,
    showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    ui?: TUI,
  ) {
    this.text = text;
    this.color = colors.roleThinking;
    this.showMarker = showMarker;
    this.mode = mode;
    this.ui = ui;
    this.textComponent = new Text(this.styled(text), 0, 0);
    if (mode === 'live') {
      this.startSpinner();
    }
  }

  invalidate(): void {}

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.textComponent.setText(this.styled(text));
  }

  private styled(text: string): string {
    return chalk.hex(this.color).italic(text);
  }

  finalize(): void {
    this.mode = 'finalized';
    this.stopSpinner();
  }

  dispose(): void {
    this.stopSpinner();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0 ? this.textComponent.render(contentWidth) : [''];

    if (this.mode === 'live') {
      const visibleLines =
        contentLines.length > RESULT_PREVIEW_LINES
          ? contentLines.slice(contentLines.length - RESULT_PREVIEW_LINES)
          : contentLines;
      const spinner = chalk.hex(this.color)(
        `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
      );
      return [
        '',
        spinner + chalk.hex(this.color)('thinking...'),
        ...visibleLines.map((line) => MESSAGE_INDENT + line),
      ];
    }

    const rendered: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p = i === 0 && this.showMarker ? chalk.hex(this.color)(STATUS_BULLET) : MESSAGE_INDENT;
      rendered.push(p + contentLines[i]);
    }

    if (this.expanded || contentLines.length <= RESULT_PREVIEW_LINES) {
      return rendered;
    }

    // Leading blank + first PREVIEW_LINES content lines + hint line.
    const truncated = rendered.slice(0, 1 + RESULT_PREVIEW_LINES);
    const remaining = contentLines.length - RESULT_PREVIEW_LINES;
    truncated.push(
      MESSAGE_INDENT + chalk.dim(`... (${String(remaining)} more lines, ctrl+o to expand)`),
    );
    return truncated;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerInterval !== undefined) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.ui?.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval === undefined) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = undefined;
  }
}
