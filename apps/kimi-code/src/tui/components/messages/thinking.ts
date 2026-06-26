/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 *
 * ## Stable Transition (fixes #981)
 *
 * During streaming, the thinking component typically sits above the visible
 * viewport. When its rendered line count changes at that position, pi-tui's
 * diff renderer hits the `firstChanged < prevViewportTop` branch and falls
 * back to a destructive fullRender (clear-screen), which jumps the terminal
 * scroll position to the top.
 *
 * To prevent this, `finalize()` enters a **stable mode** that keeps the
 * rendered line count identical to 'live' mode (spinner replaced by a static
 * bullet, same content region). The actual compact transition to the minimal
 * finalized form is deferred to `compact()`, which should be called when a
 * render cycle also changes content below the viewport (e.g., when the
 * assistant message starts streaming).
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
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export type ThinkingRenderMode = 'live' | 'finalized';

export class ThinkingComponent implements Component {
  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private stableMode = false;
  private expanded = false;
  private readonly ui: TUI | undefined;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;

  private renderCache: { width: number; lines: string[] } | undefined;

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

  private markRenderDirty(): void {
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.markRenderDirty();
    this.textComponent.setText(this.styled(this.text));
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markRenderDirty();
    this.textComponent.setText(this.styled(text));
  }

  private styled(text: string): string {
    return currentTheme.italicFg('textDim', text);
  }

  /**
   * Transition from live to finalized while keeping rendered line count
   * stable. Stops the spinner but continues to render in live-format shape
   * (same number of output lines) to avoid triggering pi-tui's destructive
   * fullRender path when this component is above the viewport.
   *
   * Call `compact()` later to switch to the minimal finalized form.
   */
  finalize(): void {
    this.stopSpinner();
    this.stableMode = true;
    this.markRenderDirty();
  }

  /**
   * Compact to the minimal finalized form (fewer rendered lines).
   *
   * This should only be called when it is safe for pi-tui to potentially
   * trigger a fullRender — typically during a render cycle that also
   * modifies content below the viewport (e.g., assistant text start).
   *
   * @returns true if the component actually changed shape
   */
  compact(): boolean {
    if (!this.stableMode) return false;
    this.stableMode = false;
    this.mode = 'finalized';
    this.markRenderDirty();
    return true;
  }

  dispose(): void {
    this.stopSpinner();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.markRenderDirty();
  }

  render(width: number): string[] {
    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === width
    ) {
      return this.renderCache.lines;
    }

    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0 ? this.textComponent.render(contentWidth) : [''];

    let rendered: string[];
    if (this.mode === 'live' || this.stableMode) {
      // Stable path: same line shape as live mode. The spinner is replaced
      // by a static bullet to stop animation, but the number of output
      // lines is identical — this keeps pi-tui on the safe differential
      // rendering path when the component is above the viewport.
      const visibleLines =
        contentLines.length > THINKING_PREVIEW_LINES
          ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
          : contentLines;
      const indicator = this.stableMode
        ? currentTheme.fg('textDim', `${STATUS_BULLET} `)
        : currentTheme.fg(
            'textDim',
            `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
          );
      rendered = [
        '',
        indicator + currentTheme.fg('textDim', this.stableMode ? 'thought' : 'thinking...'),
        ...visibleLines.map((line) => MESSAGE_INDENT + line),
      ];
    } else {
      const lines: string[] = [''];
      for (let i = 0; i < contentLines.length; i++) {
        const p = i === 0 && this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
        lines.push(p + contentLines[i]);
      }

      if (this.expanded || contentLines.length <= THINKING_PREVIEW_LINES) {
        rendered = lines;
      } else {
        // Leading blank + first PREVIEW_LINES content lines + hint line.
        const truncated = lines.slice(0, 1 + THINKING_PREVIEW_LINES);
        const remaining = contentLines.length - THINKING_PREVIEW_LINES;
        const hint = `... (${String(remaining)} more lines, ctrl+o to expand)`;
        const indentWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, width));
        const hintWidth = Math.max(0, width - indentWidth);
        truncated.push(
          ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…')),
        );
        rendered = truncated;
      }
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: rendered };
    }
    return rendered;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerInterval !== undefined) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.markRenderDirty();
      this.ui?.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval === undefined) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = undefined;
  }
}
