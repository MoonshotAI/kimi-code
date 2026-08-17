/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 *
 * The live display has two modes (tui.toml `thinking_live_display`):
 * 'preview' scrolls the last few streamed lines; 'stats' shows just the
 * elapsed thinking time, leaving a one-line "Thought for …" summary once
 * thinking finishes (ctrl+o reveals the streaming text in both modes).
 * Replayed thinking has no persisted duration, so untimed blocks fall back
 * to a plain "Thought for a while" summary instead of a fabricated 0s.
 */

import { Text, truncateToWidth, type Component, type TUI } from '@moonshot-ai/pi-tui';

import type { ThinkingLiveDisplay } from '#/tui/config';
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

export interface ThinkingComponentOptions {
  mode?: ThinkingRenderMode;
  ui?: TUI;
  liveDisplay?: ThinkingLiveDisplay;
  /** False for replayed blocks: their duration is not persisted, so no elapsed
   * time is shown anywhere. */
  timed?: boolean;
}

export class ThinkingComponent implements Component {
  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private readonly liveDisplay: ThinkingLiveDisplay;
  private readonly startedAt: number;
  private readonly timed: boolean;
  private finalizedElapsedSeconds: number | undefined;
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
    options: ThinkingComponentOptions = {},
  ) {
    this.text = text;
    this.showMarker = showMarker;
    this.mode = options.mode ?? 'finalized';
    this.ui = options.ui;
    this.liveDisplay = options.liveDisplay ?? 'preview';
    this.timed = options.timed ?? true;
    this.startedAt = Date.now();
    this.textComponent = new Text(this.styled(text), 0, 0);
    if (this.mode === 'live') {
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

  finalize(): void {
    this.mode = 'finalized';
    this.finalizedElapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    this.markRenderDirty();
    this.stopSpinner();
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
    // Stats mode hides the text unless explicitly expanded, so skip the re-wrap.
    const showContent = this.liveDisplay === 'preview' || this.expanded;
    const contentLines =
      showContent && this.text.length > 0 ? this.textComponent.render(contentWidth) : [''];

    let rendered: string[];
    if (this.mode === 'live') {
      const spinner = currentTheme.fg(
        'textDim',
        `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
      );
      if (this.liveDisplay === 'stats' && !this.expanded) {
        const label = this.timed
          ? `thinking... (${formatThinkingDuration(Math.floor((Date.now() - this.startedAt) / 1000))})`
          : 'thinking...';
        rendered = ['', spinner + currentTheme.fg('textDim', label)];
      } else {
        // Preview tail — also the expanded view of a live stats block (ctrl+o).
        const visibleLines =
          contentLines.length > THINKING_PREVIEW_LINES
            ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
            : contentLines;
        rendered = [
          '',
          spinner + currentTheme.fg('textDim', 'thinking...'),
          ...visibleLines.map((line) => MESSAGE_INDENT + line),
        ];
      }
    } else if (this.liveDisplay === 'stats' && !this.expanded) {
      // Stats mode leaves a one-line summary instead of the content preview;
      // ctrl+o expands into the full text. Untimed (replayed) blocks have no
      // persisted duration, so they get a plain "a while" instead of a fake 0s.
      const p = this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
      const hint = this.text.length > 0 ? ' (ctrl+o to expand)' : '';
      const duration = this.timed
        ? formatThinkingDuration(this.finalizedElapsedSeconds ?? 0)
        : 'a while';
      const summary = `Thought for ${duration}${hint}`;
      // Both prefixes occupy two cells (STATUS_BULLET is '● ').
      const summaryWidth = Math.max(0, width - MESSAGE_INDENT.length);
      rendered = [
        '',
        p + currentTheme.fg('textDim', truncateToWidth(summary, summaryWidth, '…')),
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

/** Compact elapsed time for the live stats line: 10s, 1m12s, 5h3m33s. */
function formatThinkingDuration(totalSeconds: number): string {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${String(hours)}h${String(minutes)}m${String(seconds)}s`;
  if (minutes > 0) return `${String(minutes)}m${String(seconds)}s`;
  return `${String(seconds)}s`;
}
