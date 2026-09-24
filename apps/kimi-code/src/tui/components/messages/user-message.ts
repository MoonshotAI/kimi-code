/**
 * Renders a user message in the transcript.
 */

import { Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@moonshot-ai/pi-tui';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import { markOsc133Zone } from '#/tui/utils/osc133';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

function firstContentLineIndex(lines: string[]): number {
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  return first;
}

/**
 * Visual row index of the message's first visible text line: one leading
 * Spacer row plus one row per leading blank logical line. The sticky pill
 * anchors its pin threshold and click target to this row. It must be derived
 * from the raw content rather than the rendered lines: the bullet prefix
 * makes even a blank first text row visibly non-empty, so scanning rendered
 * rows for the first non-blank one would miss leading blank lines.
 */
export function userMessageContentOffset(text: string): number {
  return 1 + firstContentLineIndex(text.split(/\r?\n/));
}

/**
 * Visual row count of each logical content line after the leading blanks, at
 * the width the message would render with its bullet. The sticky pill uses
 * this to map "visual rows scrolled out" back to logical lines.
 */
export function userMessageLineHeights(text: string, width: number, bullet?: string): number[] {
  const marker = bullet ?? USER_MESSAGE_BULLET;
  const contentWidth = Math.max(1, width - visibleWidth(marker));
  const lines = text.split(/\r?\n/);
  return lines
    .slice(firstContentLineIndex(lines))
    .map((line) => wrapTextWithAnsi(line.replaceAll('\t', '   '), contentWidth).length);
}

export class UserMessageComponent implements Component {
  private text: string;
  private readonly bullet?: string;
  private spacerComponent: Spacer;
  private imageThumbnails: ImageThumbnail[];

  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(text: string, images?: ImageAttachment[], bullet?: string) {
    this.text = text;
    this.bullet = bullet;
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img)) ?? [];
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

    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth
    ) {
      return this.renderCache.lines;
    }

    const marker = this.bullet ?? USER_MESSAGE_BULLET;
    const bullet = marker.length > 0 ? currentTheme.boldFg('roleUser', marker) : '';
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);

    const lines: string[] = [];

    // Spacer
    for (const line of this.spacerComponent.render(safeWidth)) {
      lines.push(line);
    }

    // Text is re-dyed from the current theme; invalidate() (theme change) clears
    // the render cache so the new colours are picked up on the next render.
    const coloredText = currentTheme.boldFg('roleUser', this.text);
    const textLines = new Text(coloredText, 0, 0).render(contentWidth);
    for (let i = 0; i < textLines.length; i++) {
      const prefix = i === 0 ? bullet : ' '.repeat(bulletWidth);
      lines.push(prefix + textLines[i]);
    }

    // Images — indented to align with text after the bullet
    for (const thumbnail of this.imageThumbnails) {
      const imageLines = thumbnail.render(contentWidth);
      for (const line of imageLines) {
        lines.push(' '.repeat(bulletWidth) + line);
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
      this.renderCache = { width: safeWidth, lines: rendered };
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
