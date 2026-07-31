/**
 * Renders the user's most recently sent message as a band pinned to the top
 * of the viewport (mounted as a non-capturing, top-anchored overlay), so the
 * prompt that kicked off the current work stays visible while the transcript
 * scrolls underneath — same idea as Claude Code's pinned prompt.
 *
 * The component snapshots the message text (the transcript window may trim
 * the original UserMessageComponent) and stays invisible until the original
 * message has scrolled above the viewport, so it never duplicates content
 * that is still on screen. Visibility lags one frame because it is derived
 * from the engine's last-completed frame (`TUI.getViewportTop`), which is
 * imperceptible in practice.
 */

import { Text, truncateToWidth, visibleWidth, type Component, type TUI } from '@moonshot-ai/pi-tui';

import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

/** Maximum band height in rows; longer messages are ellipsized. */
const MAX_LINES = 3;

const EMPTY_LINES: string[] = [];

export class PinnedUserMessageComponent implements Component {
  private readonly tui: TUI;
  private readonly isEnabled: () => boolean;
  private text = '';
  /** Buffer line count recorded when the message was sent; the transcript
   * entry occupies the lines right after it. */
  private anchorLine = 0;
  private generation = 0;

  private wrapCache: { width: number; lines: string[] } | undefined;
  private bandCache:
    | { width: number; generation: number; visible: boolean; lines: string[] }
    | undefined;

  constructor(tui: TUI, isEnabled: () => boolean) {
    this.tui = tui;
    this.isEnabled = isEnabled;
  }

  /** Snapshot a freshly sent user message. `anchorLine` should be the
   * engine's current content height (`TUI.getContentHeight`). */
  setMessage(text: string, anchorLine: number): void {
    this.text = text;
    this.anchorLine = anchorLine;
    this.generation += 1;
    this.wrapCache = undefined;
    this.bandCache = undefined;
  }

  /** Hide the pin (session clear / new session). */
  clear(): void {
    if (this.text.length === 0) return;
    this.text = '';
    this.generation += 1;
    this.wrapCache = undefined;
    this.bandCache = undefined;
  }

  invalidate(): void {
    // Theme change: re-dye from the current palette on the next render.
    this.bandCache = undefined;
  }

  /** Plain-text wrap of the message at `contentWidth`, cached per width. */
  private wrapLines(contentWidth: number): string[] {
    if (this.wrapCache !== undefined && this.wrapCache.width === contentWidth) {
      return this.wrapCache.lines;
    }
    const lines = new Text(this.text, 0, 0).render(contentWidth);
    this.wrapCache = { width: contentWidth, lines };
    return lines;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0 || this.text.length === 0 || !this.isEnabled()) return EMPTY_LINES;

    const bullet = USER_MESSAGE_BULLET;
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);
    const wrapped = this.wrapLines(contentWidth);

    // The transcript renders a 1-line spacer above the message; mirror that
    // when estimating where the original entry ends.
    const fullHeight = wrapped.length + 1;
    const visible = this.tui.getViewportTop() > this.anchorLine + fullHeight;

    if (
      this.bandCache !== undefined &&
      this.bandCache.width === safeWidth &&
      this.bandCache.generation === this.generation &&
      this.bandCache.visible === visible
    ) {
      return this.bandCache.lines;
    }

    let lines: string[] = EMPTY_LINES;
    if (visible) {
      let capped = wrapped;
      if (wrapped.length > MAX_LINES) {
        capped = wrapped.slice(0, MAX_LINES);
        // Ellipsize the last visible row, guaranteeing the marker fits.
        const last = truncateToWidth(capped[MAX_LINES - 1]!, Math.max(1, contentWidth - 2), '');
        capped[MAX_LINES - 1] = `${last} …`;
      }
      lines = capped.map((line, index) => {
        const prefix = index === 0 ? bullet : ' '.repeat(bulletWidth);
        const styled = currentTheme.boldFg('roleUser', prefix + line);
        const pad = Math.max(0, safeWidth - visibleWidth(styled));
        return currentTheme.bg('border', styled + ' '.repeat(pad));
      });
    }

    this.bandCache = { width: safeWidth, generation: this.generation, visible, lines };
    return lines;
  }
}
