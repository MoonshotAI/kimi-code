/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 */

import { Text, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MESSAGE_INDENT,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type ThinkingRenderMode = 'live' | 'finalized';

export class ThinkingComponent implements Component {
  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private expanded = false;
  private readonly ui: TUI | undefined;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  private spinnerRenderTimer: ReturnType<typeof setTimeout> | null = null;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;

  constructor(
    text: string,
    showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    ui?: TUI,
  ) {
    this.text = text;
    this.showMarker = showMarker;
    this.mode = mode;
    this.ui = ui;
    this.textComponent = new Text(this.styled(text), 0, 0);
    if (mode === 'live') {
      this.startSpinner();
    }
  }

  invalidate(): void {
    this.textComponent.setText(this.styled(this.text));
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.textComponent.setText(this.styled(text));
  }

  private styled(text: string): string {
    return currentTheme.italicFg('textDim', text);
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
        contentLines.length > THINKING_PREVIEW_LINES
          ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
          : contentLines;
      const spinner = currentTheme.fg(
        'textDim',
        `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
      );
      return [
        '',
        spinner + currentTheme.fg('textDim', 'thinking...'),
        ...visibleLines.map((line) => MESSAGE_INDENT + line),
      ];
    }

    const rendered: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p = i === 0 && this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
      rendered.push(p + contentLines[i]);
    }

    if (this.expanded || contentLines.length <= THINKING_PREVIEW_LINES) {
      return rendered;
    }

    // Leading blank + first PREVIEW_LINES content lines + hint line.
    const truncated = rendered.slice(0, 1 + THINKING_PREVIEW_LINES);
    const remaining = contentLines.length - THINKING_PREVIEW_LINES;
    const hint = `... (${String(remaining)} more lines, ctrl+o to expand)`;
    const indentWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, width));
    const hintWidth = Math.max(0, width - indentWidth);
    truncated.push(
      ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…')),
    );
    return truncated;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerInterval !== undefined) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.scheduleSpinnerRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  /**
   * Throttle spinner renders to avoid full transcript re-layout on every
   * animation frame. The frame index advances at the animation interval, but
   * the expensive requestRender is coalesced to ~200ms — matching the pattern
   * used by AgentGroupComponent.
   */
  private scheduleSpinnerRender(): void {
    if (this.spinnerRenderTimer !== null) return;
    this.spinnerRenderTimer = setTimeout(() => {
      this.spinnerRenderTimer = null;
      this.ui?.requestRender();
    }, 200);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval === undefined) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = undefined;
    if (this.spinnerRenderTimer !== null) {
      clearTimeout(this.spinnerRenderTimer);
      this.spinnerRenderTimer = null;
    }
    this.ui?.requestRender();
  }
}
