import {
  Container,
  prefixRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  textRenderLine,
  truncateRenderLine,
  type TuiRenderLine,
  visibleWidth,
  withRenderLineText,
  type Component,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';

import { Markdown } from '#/tui/components/markdown/markdown';
import type { TranscriptRowParts } from '#/tui/components/messages/transcript-row-layout';
import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';
import { markOsc133Zone } from '#/tui/utils/osc133';
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
  private projectionVersion = 0;

  private renderCache: { width: number; lines: TuiRenderLine[] } | undefined;
  private transcriptRowCache: { width: number; parts: TranscriptRowParts } | undefined;

  constructor(showBullet: boolean = true) {
    this.showBullet = showBullet;
    this.contentContainer = new Container();
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
    this.transcriptRowCache = undefined;
  }

  setShowBullet(show: boolean): void {
    if (this.showBullet === show) return;
    this.showBullet = show;
    this.markRenderDirty();
  }

  updateContent(text: string, opts?: AssistantMarkdownOptions): void {
    const displayText = text.trim();
    const transient = opts?.transient === true;

    if (displayText === this.lastText && transient === this.lastTransient) return;

    if ((this.lastText.length === 0) !== (displayText.length === 0)) {
      this.projectionVersion += 1;
    }
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
        {
          ...createMarkdownOptions(),
          copySource: true,
          onVisualStateChange: () => this.markRenderDirty(),
        },
      );
      this.markdownTransient = transient;
      this.contentContainer.addChild(this.markdown);
      return;
    }

    this.markdown.setText(displayText);
  }

  get transcriptProjectionVersion(): number {
    return this.projectionVersion;
  }

  get hasVisibleContent(): boolean {
    return this.lastText.length > 0;
  }

  invalidate(): void {
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
        {
          ...createMarkdownOptions(),
          copySource: true,
          onVisualStateChange: () => this.markRenderDirty(),
        },
      );
      this.markdownTransient = this.lastTransient;
      this.contentContainer.addChild(this.markdown);
    }
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    const prefixWidth = visibleWidth(this.showBullet ? STATUS_BULLET : MESSAGE_INDENT);
    if (this.lastText.trim().length === 0) {
      return { gutterWidth: prefixWidth, gutterLines: [], contentLines: [] };
    }

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) {
      const lines = [textRenderLine('')];
      return { gutterWidth: 0, gutterLines: lines, contentLines: lines };
    }
    if (isRenderCacheEnabled() && this.transcriptRowCache?.width === safeWidth) {
      return this.transcriptRowCache.parts;
    }

    const bodyLines = renderComponentLines(
      this.contentContainer,
      Math.max(1, safeWidth - prefixWidth),
    );
    const contentLines = [textRenderLine(''), ...bodyLines];
    const marked = markOsc133Zone(contentLines.map((line) => line.text));
    const markedContent = contentLines.map((line, index) =>
      withRenderLineText(line, marked[index]!)
    );
    const gutterLines = markedContent.map((_, index) => {
      if (index === 0) return textRenderLine('');
      return textRenderLine(
        index === 1 && this.showBullet
          ? currentTheme.fg('text', STATUS_BULLET)
          : MESSAGE_INDENT,
      );
    });
    const parts = { gutterWidth: prefixWidth, gutterLines, contentLines: markedContent };
    if (isRenderCacheEnabled()) {
      this.transcriptRowCache = { width: safeWidth, parts };
    }
    return parts;
  }

  selectionExclusions() {
    return [{ start: 0, end: visibleWidth(this.showBullet ? STATUS_BULLET : MESSAGE_INDENT) }];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (this.lastText.trim().length === 0) return undefined;

    const prefix = this.showBullet ? STATUS_BULLET : MESSAGE_INDENT;
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(1, Math.max(0, event.width) - prefixWidth);
    const y = event.y - 1;
    if (y < 0) return undefined;

    const contentHeight = this.contentContainer.render(contentWidth).length;
    if (y >= contentHeight) return undefined;

    return this.contentContainer.handleMouse({
      ...event,
      x: event.x - prefixWidth,
      y,
      width: contentWidth,
      height: contentHeight,
    });
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    if (this.lastText.trim().length === 0) return [];

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [textRenderLine('')];

    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth
    ) {
      return this.renderCache.lines;
    }

    const prefix = this.showBullet ? STATUS_BULLET : MESSAGE_INDENT;
    const contentWidth = Math.max(1, safeWidth - visibleWidth(prefix));
    const contentLines = renderComponentLines(this.contentContainer, contentWidth);

    const lines: TuiRenderLine[] = [textRenderLine('')];
    for (let i = 0; i < contentLines.length; i++) {
      const p =
        i === 0 && this.showBullet ? currentTheme.fg('text', STATUS_BULLET) : MESSAGE_INDENT;
      lines.push(truncateRenderLine(prefixRenderLine(contentLines[i]!, p), safeWidth, '…'));
    }
    const marked = markOsc133Zone(lines.map((line) => line.text));
    const rendered = lines.map((line, index) => withRenderLineText(line, marked[index]!));
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}
