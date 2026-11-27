import {
  offsetRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  sliceByColumn,
  textRenderLine,
  visibleWidth,
  withRenderLineSelectionRegion,
  withRenderLineText,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';

import { prefixPreservingOsc133Zone } from '#/tui/utils/osc133';

export interface TranscriptRowParts {
  readonly gutterWidth: number;
  readonly gutterWidths?: readonly number[];
  readonly gutterLines: readonly TuiRenderLine[];
  readonly contentLines: readonly TuiRenderLine[];
}

export interface TranscriptRowRenderable {
  renderTranscriptRow(width: number): TranscriptRowParts;
}

const EMPTY_RENDER_LINES: readonly TuiRenderLine[] = [];

interface TranscriptRowRenderCache {
  readonly width: number;
  readonly gutterWidth: number;
  readonly gutterWidths: readonly number[] | undefined;
  readonly gutterLines: readonly TuiRenderLine[];
  readonly contentLines: readonly TuiRenderLine[];
  readonly lines: TuiRenderLine[];
}

export function isTranscriptRowRenderable(
  component: Component,
): component is Component & TranscriptRowRenderable {
  return 'renderTranscriptRow' in component && typeof component.renderTranscriptRow === 'function';
}

export function flattenTranscriptRow(parts: TranscriptRowParts, width: number): TuiRenderLine[] {
  const lineCount = Math.max(parts.gutterLines.length, parts.contentLines.length);
  const lines: TuiRenderLine[] = [];
  let blankColumn: number | undefined;
  for (let index = 0; index < lineCount; index++) {
    const requestedGutterWidth = parts.gutterWidths?.[index] ?? parts.gutterWidth;
    const gutterWidth = Math.min(Math.max(0, requestedGutterWidth), Math.max(0, width - 1));
    const clamped = gutterWidth !== Math.max(0, requestedGutterWidth);
    const gutter = parts.gutterLines[index];
    const content = parts.contentLines[index] ?? textRenderLine('');
    const renderedContent = width <= 0 ? withRenderLineText(content, '') : content;
    const gutterText = gutter?.text ?? '';
    const renderedGutter = clamped && visibleWidth(gutterText) > gutterWidth
      ? sliceByColumn(gutterText, 0, gutterWidth, true)
      : gutterText;
    const blankContent = parts.contentLines[index] !== undefined &&
      visibleWidth(content.text) === 0 &&
      renderedGutter.trim().length === 0;
    let selectionColumn = gutterWidth;
    if (blankContent && gutterWidth === 0) {
      blankColumn ??= firstContentGutterWidth(parts, lineCount);
      selectionColumn = Math.min(blankColumn, Math.max(0, width - 1));
    }
    const paddingWidth = blankContent ? 0 : Math.max(0, gutterWidth - visibleWidth(renderedGutter));
    const line = withRenderLineText(
      offsetRenderLine(renderedContent, gutterWidth),
      prefixPreservingOsc133Zone(renderedContent.text, blankContent ? '' : renderedGutter + ' '.repeat(paddingWidth)),
    );
    lines.push(
      withRenderLineSelectionRegion(line, content, selectionColumn, Math.max(0, width - selectionColumn)),
    );
  }
  return lines;
}

function firstContentGutterWidth(parts: TranscriptRowParts, lineCount: number): number {
  for (let index = 0; index < lineCount; index++) {
    const content = parts.contentLines[index];
    if (content !== undefined && visibleWidth(content.text) > 0) {
      return Math.max(0, parts.gutterWidths?.[index] ?? parts.gutterWidth);
    }
  }
  return 0;
}

export class TranscriptRowLayout implements Component, TranscriptRowRenderable {
  private renderCache: TranscriptRowRenderCache | undefined;

  constructor(readonly child: Component) {}

  renderTranscriptRow(width: number): TranscriptRowParts {
    if (isTranscriptRowRenderable(this.child)) return this.child.renderTranscriptRow(width);
    return {
      gutterWidth: 0,
      gutterLines: EMPTY_RENDER_LINES,
      contentLines: renderComponentLines(this.child, width),
    };
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    const parts = this.renderTranscriptRow(width);
    const cache = this.renderCache;
    if (
      cache?.width === width &&
      cache.gutterWidth === parts.gutterWidth &&
      cache.gutterWidths === parts.gutterWidths &&
      cache.gutterLines === parts.gutterLines &&
      cache.contentLines === parts.contentLines
    ) {
      return cache.lines;
    }
    const lines = flattenTranscriptRow(parts, width);
    this.renderCache = {
      width,
      gutterWidth: parts.gutterWidth,
      gutterWidths: parts.gutterWidths,
      gutterLines: parts.gutterLines,
      contentLines: parts.contentLines,
      lines,
    };
    return lines;
  }

  invalidate(): void {
    this.renderCache = undefined;
    this.child.invalidate();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.child.handleMouse?.(event);
  }
}
