/**
 * Renders a user message in the transcript.
 */

import { Spacer, Text, truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { formatTimestamp, timestampDisplayContextKey } from '#/tui/utils/format-time';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import { markOsc133Zone } from '#/tui/utils/osc133';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export class UserMessageComponent implements Component {
  private text: string;
  private readonly bullet?: string;
  private readonly timestamp?: number;
  private showTimestamp = true;
  private spacerComponent: Spacer;
  private imageThumbnails: ImageThumbnail[];

  private renderCache:
    | { width: number; timestampContextKey: string; lines: string[] }
    | undefined;

  constructor(
    text: string,
    images?: ImageAttachment[],
    bullet?: string,
    timestamp?: number,
    showTimestamp = true,
  ) {
    this.text = text;
    this.bullet = bullet;
    this.timestamp = timestamp;
    this.showTimestamp = showTimestamp;
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img)) ?? [];
  }

  setShowTimestamp(show: boolean): void {
    if (this.showTimestamp === show) return;
    this.showTimestamp = show;
    this.markRenderDirty();
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.markRenderDirty();
    for (const img of this.imageThumbnails) {
      img.invalidate?.();
    }
  }

  render(width: number): string[] {
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

    const lines: string[] = [];

    // Spacer
    for (const line of this.spacerComponent.render(safeWidth)) {
      lines.push(line);
    }

    const marker = this.bullet ?? USER_MESSAGE_BULLET;
    const formattedTime = this.showTimestamp ? formatTimestamp(this.timestamp, undefined, now) : '';

    if (formattedTime.length > 0) {
      const headerMarker = marker.length > 0 ? currentTheme.boldFg('roleUser', marker) : '';
      lines.push(`${headerMarker}${currentTheme.dim(formattedTime)}`);
    } else if (marker.length > 0) {
      lines.push(currentTheme.boldFg('roleUser', marker));
    }

    const coloredText = currentTheme.boldFg('roleUser', this.text);
    const textLines = new Text(coloredText, 0, 0).render(safeWidth);
    for (const line of textLines) {
      lines.push(line);
    }
    for (const thumbnail of this.imageThumbnails) {
      const imageLines = thumbnail.render(safeWidth);
      for (const line of imageLines) {
        lines.push(line);
      }
    }

    const rendered = markOsc133Zone(
      lines.map((line) => {
        // Inline image sequences (Kitty / iTerm2) carry their own placement
        // information and have zero visible width, but pi-tui's truncateToWidth
        // treats the embedded base64 payload as visible text and would chop the
        // escape sequence in half, leaving garbage like "0m...". Skip truncation
        // for those lines; the image itself already respects maxWidthCells.
        if (isImageLine(line)) return line;
        return truncateToWidth(line, safeWidth, '…');
      }),
    );
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, timestampContextKey, lines: rendered };
    }
    return rendered;
  }
}

function isImageLine(line: string): boolean {
  return line.includes('\u001B_G') || line.includes('\u001B]1337;File=');
}

/**
 * Invisible turn-boundary marker for replay. Some replayed records start a
 * new turn without anything to show — the goal driver's synthetic
 * continuation prompt is model-facing and never rendered live — but the
 * transcript still needs a mounted boundary component so step/assistant
 * folding (and window trimming) can find the turn edges. Renders zero lines.
 */
export class ReplayTurnBoundaryComponent implements Component {
  invalidate(): void {}
  render(_width: number): string[] {
    return [];
  }
}
