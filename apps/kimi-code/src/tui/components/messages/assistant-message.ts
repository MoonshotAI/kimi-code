/**
 * Renders an assistant message using pi-tui Markdown.
 *
 * Displays a white bullet prefix with markdown content indented
 * to align after the bullet.
 */

import { Container, Markdown, truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';
import { markOsc133Zone } from '#/tui/utils/osc133';
import { formatTimestamp, timestampDisplayContextKey } from '#/tui/utils/format-time';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

type AssistantMarkdownOptions = {
  transient?: boolean;
};

export class AssistantMessageComponent implements Component {
  private contentContainer: Container;
  private markdown: Markdown | undefined;
  private markdownTransient = false;
  private lastText = '';
  private lastTransient = false;
  private showBullet: boolean;
  private timestamp?: number;
  private endedAt?: number;
  private showTimestamp = true;

  private renderCache:
    | { width: number; timestampContextKey: string; lines: string[] }
    | undefined;

  constructor(
    showBullet: boolean = true,
    timestamp?: number,
    endedAt?: number,
    showTimestamp = true,
  ) {
    this.showBullet = showBullet;
    this.timestamp = timestamp;
    this.endedAt = endedAt;
    this.showTimestamp = showTimestamp;
    this.contentContainer = new Container();
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
  }

  setShowBullet(show: boolean): void {
    if (this.showBullet === show) return;
    this.showBullet = show;
    this.markRenderDirty();
  }

  setTimestamp(timestamp?: number): void {
    if (this.timestamp === timestamp) return;
    this.timestamp = timestamp;
    this.markRenderDirty();
  }

  setEndedAt(endedAt?: number): void {
    if (this.endedAt === endedAt) return;
    this.endedAt = endedAt;
    this.markRenderDirty();
  }

  setShowTimestamp(show: boolean): void {
    if (this.showTimestamp === show) return;
    this.showTimestamp = show;
    this.markRenderDirty();
  }

  updateContent(text: string, opts?: AssistantMarkdownOptions): void {
    const displayText = text.trim();
    const transient = opts?.transient === true;

    if (displayText === this.lastText && transient === this.lastTransient) return;

    this.lastText = displayText;
    this.lastTransient = transient;
    this.markRenderDirty();

    if (displayText.length === 0) {
      this.contentContainer.clear();
      this.markdown = undefined;
      this.markdownTransient = false;
      return;
    }

    if (this.markdown === undefined || this.markdownTransient !== transient) {
      this.contentContainer.clear();
      this.markdown = new Markdown(
        displayText,
        0,
        0,
        createMarkdownTheme({ transient }),
        undefined,
        createMarkdownOptions(),
      );
      this.markdownTransient = transient;
      this.contentContainer.addChild(this.markdown);
      return;
    }

    this.markdown.setText(displayText);
  }

  invalidate(): void {
    // Markdown caches ANSI colour codes keyed on (text, width).  When the
    // theme changes the cached strings contain stale colours, so we rebuild
    // the Markdown child with the new theme while preserving transient mode.
    this.markRenderDirty();
    this.contentContainer.clear();
    this.markdown = undefined;

    if (this.lastText.trim().length > 0) {
      this.markdown = new Markdown(
        this.lastText.trim(),
        0,
        0,
        createMarkdownTheme({ transient: this.lastTransient }),
        undefined,
        createMarkdownOptions(),
      );
      this.markdownTransient = this.lastTransient;
      this.contentContainer.addChild(this.markdown);
    }
  }

  render(width: number): string[] {
    if (this.lastText.trim().length === 0) return [];

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const now = Date.now();
    const timestampContextKey = this.showTimestamp
      ? timestampDisplayContextKey(this.timestamp, now)
      : '';

    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth &&
      this.renderCache.timestampContextKey === timestampContextKey
    ) {
      return this.renderCache.lines;
    }

    const lines: string[] = [''];
    const formattedTime = this.showTimestamp
      ? formatTimestamp(this.timestamp, this.endedAt, now)
      : '';

    if (this.showBullet) {
      const bulletText = currentTheme.boldFg('textStrong', STATUS_BULLET);
      const headerText = formattedTime.length > 0 ? `${bulletText}${currentTheme.dim(formattedTime)}` : bulletText;
      lines.push(headerText);
    } else if (formattedTime.length > 0) {
      lines.push(currentTheme.dim(formattedTime));
    }

    const contentLines = this.contentContainer.render(safeWidth);
    for (const line of contentLines) {
      lines.push(line);
    }
    const rendered = markOsc133Zone(lines.map((line) => truncateToWidth(line, safeWidth, '…')));
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, timestampContextKey, lines: rendered };
    }
    return rendered;
  }
}
