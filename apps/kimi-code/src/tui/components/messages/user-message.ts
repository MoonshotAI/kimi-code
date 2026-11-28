import {
  prefixRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  Spacer,
  Text,
  textRenderLine,
  truncateRenderLine,
  visibleWidth,
  withRenderLineText,
  wrapTextWithAnsi,
  type Component,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import type { TranscriptRowParts } from '#/tui/components/messages/transcript-row-layout';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import { findInlineSkillTokens } from '#/tui/utils/inline-skill-tokens';
import { markOsc133Zone } from '#/tui/utils/osc133';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export function firstContentLineIndex(lines: string[]): number {
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  return first;
}

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
  private readonly skillNames?: readonly string[];
  private spacerComponent: Spacer;
  private imageThumbnails: ImageThumbnail[];
  private steerPending: boolean;

  private renderCache: { width: number; lines: TuiRenderLine[] } | undefined;
  private transcriptRowCache: { width: number; parts: TranscriptRowParts } | undefined;

  constructor(
    text: string,
    images?: ImageAttachment[],
    bullet?: string,
    skillNames?: readonly string[],
    steerPending = false,
  ) {
    this.text = text;
    this.bullet = bullet;
    this.skillNames = skillNames;
    this.steerPending = steerPending;
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img)) ?? [];
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
    this.transcriptRowCache = undefined;
  }

  isSteerPending(): boolean {
    return this.steerPending;
  }

  setSteerPending(pending: boolean): void {
    if (this.steerPending === pending) return;
    this.steerPending = pending;
    this.markRenderDirty();
  }

  colorText(text: string): string {
    const names = this.skillNames;
    if (names === undefined || names.length === 0) {
      return currentTheme.boldFg('roleUser', text);
    }
    const known = new Set(names.map(normalizeSkillTokenName));
    const tokens = findInlineSkillTokens(text, {
      isKnownSkill: (commandName) => known.has(normalizeSkillTokenName(commandName)),
      includeLeading: true,
    });
    if (tokens.length === 0) {
      return currentTheme.boldFg('roleUser', text);
    }
    const segments: string[] = [];
    let cursor = 0;
    for (const token of tokens) {
      if (token.start > cursor) {
        segments.push(currentTheme.boldFg('roleUser', text.slice(cursor, token.start)));
      }
      segments.push(currentTheme.boldFg('primary', text.slice(token.start, token.end)));
      cursor = token.end;
    }
    if (cursor < text.length) {
      segments.push(currentTheme.boldFg('roleUser', text.slice(cursor)));
    }
    return segments.join('');
  }

  invalidate(): void {
    this.markRenderDirty();
    for (const img of this.imageThumbnails) {
      img.invalidate?.();
    }
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) {
      const lines = [textRenderLine('')];
      return { gutterWidth: 0, gutterLines: lines, contentLines: lines };
    }
    if (isRenderCacheEnabled() && this.transcriptRowCache?.width === safeWidth) {
      return this.transcriptRowCache.parts;
    }

    const marker = this.bullet ?? USER_MESSAGE_BULLET;
    const bullet = marker.length > 0 ? currentTheme.boldFg('roleUser', marker) : '';
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);
    const spacerLines = renderComponentLines(this.spacerComponent, contentWidth);
    const textLines = renderComponentLines(new Text(this.colorText(this.text), 0, 0), contentWidth);
    const imageLines = this.imageThumbnails.flatMap((thumbnail) =>
      thumbnail.render(contentWidth).map((line) => textRenderLine(line))
    );
    const contentLines = [
      ...spacerLines,
      ...textLines.map((line) => this.steerPending
        ? withRenderLineText(line, currentTheme.fade(line.text))
        : line),
      ...imageLines,
    ];
    const marked = markOsc133Zone(contentLines.map((line) => line.text));
    const markedContent = contentLines.map((line, index) =>
      withRenderLineText(line, marked[index]!)
    );
    const gutterLines = [
      ...spacerLines.map(() => textRenderLine('')),
      ...textLines.map((_, index) => {
        const gutter = index === 0 ? bullet : ' '.repeat(bulletWidth);
        return textRenderLine(index === 0 && this.steerPending ? currentTheme.fade(gutter) : gutter);
      }),
      ...imageLines.map(() => textRenderLine(' '.repeat(bulletWidth))),
    ];
    const parts = { gutterWidth: bulletWidth, gutterLines, contentLines: markedContent };
    if (isRenderCacheEnabled()) {
      this.transcriptRowCache = { width: safeWidth, parts };
    }
    return parts;
  }

  selectionExclusions() {
    return [{ start: 0, end: visibleWidth(this.bullet ?? USER_MESSAGE_BULLET) }];
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [textRenderLine('')];

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

    const lines: TuiRenderLine[] = [...renderComponentLines(this.spacerComponent, safeWidth)];

    const textLines = renderComponentLines(new Text(this.colorText(this.text), 0, 0), contentWidth);
    for (let i = 0; i < textLines.length; i++) {
      const prefix = i === 0 ? bullet : ' '.repeat(bulletWidth);
      const line = prefixRenderLine(textLines[i]!, prefix);
      lines.push(this.steerPending ? withRenderLineText(line, currentTheme.fade(line.text)) : line);
    }

    for (const thumbnail of this.imageThumbnails) {
      const imageLines = thumbnail.render(contentWidth);
      for (const line of imageLines) {
        lines.push(prefixRenderLine(textRenderLine(line), ' '.repeat(bulletWidth)));
      }
    }

    const truncated = lines.map((line) =>
      isImageLine(line.text) ? line : truncateRenderLine(line, safeWidth, '…'),
    );
    const marked = markOsc133Zone(truncated.map((line) => line.text));
    const rendered = truncated.map((line, index) => withRenderLineText(line, marked[index]!));
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}

function normalizeSkillTokenName(name: string): string {
  return name.startsWith('skill:') ? name.slice('skill:'.length) : name;
}

function isImageLine(line: string): boolean {
  return line.includes('\u001B_G') || line.includes('\u001B]1337;File=');
}

export class ReplayTurnBoundaryComponent implements Component {
  invalidate(): void {}
  render(_width: number): string[] {
    return [];
  }
}
