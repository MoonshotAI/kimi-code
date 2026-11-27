import {
  renderComponentLines,
  sliceByColumn,
  textRenderLine,
  visibleWidth,
  type Component,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';

import { ANSI_ESCAPE_PATTERN } from '#/tui/constant/rendering';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

import { LeadingDecorationText } from '../leading-decoration-text';
import {
  isTranscriptRowRenderable,
  type TranscriptRowParts,
} from '../transcript-row-layout';

interface TranscriptRowCache {
  readonly width: number;
  readonly source: readonly TuiRenderLine[];
  readonly gutterWidths: readonly number[];
  readonly firstGutterText: string | undefined;
  readonly parts: TranscriptRowParts;
}

const transcriptRowCaches = new WeakMap<Component, TranscriptRowCache>();

function sameExclusions(left: TuiRenderLine, right: TuiRenderLine): boolean {
  const leftRanges = left.selectionExclusions ?? [];
  const rightRanges = right.selectionExclusions ?? [];
  return leftRanges.length === rightRanges.length && leftRanges.every((range, index) =>
    range.start === rightRanges[index]?.start && range.end === rightRanges[index]?.end
  );
}

function sameSource(left: readonly TuiRenderLine[], right: readonly TuiRenderLine[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    return false;
  }
  return leftKeys.every((key) => {
    const index = Number(key);
    const previous = left[index]!;
    const next = right[index]!;
    if (previous.softWrap !== undefined || next.softWrap !== undefined) return previous === next;
    return previous.text === next.text && sameExclusions(previous, next);
  });
}

function sameWidths(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((width, index) => width === right[index]);
}

function contentLine(line: TuiRenderLine, gutterWidth: number): TuiRenderLine {
  if (gutterWidth === 0) return line;
  const width = visibleWidth(line.text);
  const softWrap = line.softWrap?.flatMap((fragment) => {
    const start = Math.max(0, fragment.start - gutterWidth);
    const end = Math.max(0, fragment.end - gutterWidth);
    if (end <= start && fragment.end > fragment.start) return [];
    const continuation = fragment.continuation === undefined
      ? undefined
      : {
          ...fragment.continuation,
          generatedIndent: Math.max(0, fragment.continuation.generatedIndent - gutterWidth),
        };
    return [{
      ...fragment,
      start,
      end,
      ...(continuation === undefined ? {} : { continuation }),
    }];
  });
  const selectionExclusions = line.selectionExclusions
    ?.map((range) => ({
      start: Math.max(0, range.start - gutterWidth),
      end: Math.max(0, range.end - gutterWidth),
    }))
    .filter((range) => range.end > range.start);
  const text = sliceByColumn(line.text, gutterWidth, Math.max(0, width - gutterWidth), true);
  let terminalSuffix = '';
  let offset = 0;
  for (const match of line.text.matchAll(new RegExp(ANSI_ESCAPE_PATTERN))) {
    if (match.index > offset) terminalSuffix = '';
    terminalSuffix += match[0];
    offset = match.index + match[0].length;
  }
  if (offset < line.text.length) terminalSuffix = '';
  return {
    text: text + terminalSuffix,
    ...(softWrap === undefined ? {} : { softWrap }),
    ...(selectionExclusions === undefined ? {} : { selectionExclusions }),
  };
}

export function splitToolTranscriptRow(
  component: Component,
  source: readonly TuiRenderLine[],
  width: number,
  gutter: number | readonly number[],
  firstGutterText?: string,
): TranscriptRowParts {
  const safeWidth = Math.max(0, width);
  const gutterWidths: number[] = [];
  const sourceKeys = Object.keys(source);
  for (const key of sourceKeys) {
    const index = Number(key);
    const requested = typeof gutter === 'number' ? gutter : (gutter[index] ?? 0);
    gutterWidths[index] = Math.min(Math.max(0, requested), safeWidth);
  }
  const cached = transcriptRowCaches.get(component);
  if (
    isRenderCacheEnabled() &&
    cached?.width === safeWidth &&
    cached.firstGutterText === firstGutterText &&
    sameWidths(cached.gutterWidths, gutterWidths) &&
    sameSource(cached.source, source)
  ) {
    return cached.parts;
  }

  const gutterLines: TuiRenderLine[] = [];
  const contentLines: TuiRenderLine[] = [];
  let gutterWidth = 0;
  for (const key of sourceKeys) {
    const index = Number(key);
    const line = source[index]!;
    const lineGutterWidth = gutterWidths[index]!;
    gutterWidth = Math.max(gutterWidth, lineGutterWidth);
    gutterLines[index] = textRenderLine(
      index === 0 && firstGutterText !== undefined
        ? firstGutterText
        : sliceByColumn(line.text, 0, lineGutterWidth, true),
    );
    contentLines[index] = contentLine(line, lineGutterWidth);
  }
  const parts: TranscriptRowParts = {
    gutterWidth,
    gutterWidths,
    gutterLines,
    contentLines,
  };
  transcriptRowCaches.set(component, { width: safeWidth, source, gutterWidths, firstGutterText, parts });
  return parts;
}

export function toolTranscriptGutterWidths(lines: readonly TuiRenderLine[]): number[] {
  const widths: number[] = [];
  for (const key of Object.keys(lines)) {
    const index = Number(key);
    widths[index] = lines[index]!.selectionExclusions?.find((range) => range.start === 0)?.end ?? 0;
  }
  return widths;
}

export function renderToolTranscriptRow(component: Component, width: number): TranscriptRowParts {
  if (isTranscriptRowRenderable(component)) return component.renderTranscriptRow(width);
  const lines = renderComponentLines(component, width);
  return splitToolTranscriptRow(component, lines, width, toolTranscriptGutterWidths(lines));
}

export class ToolTranscriptText extends LeadingDecorationText {
  constructor(
    text: string,
    private readonly transcriptDecorationWidth: number,
    paddingX = 0,
    paddingY = 0,
    decorationWidth?: number,
  ) {
    super(text, paddingX, paddingY, decorationWidth);
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    const lines = renderComponentLines(this, width);
    const gutterWidths: number[] = [];
    for (const key of Object.keys(lines)) {
      const index = Number(key);
      gutterWidths[index] = index === 0 ? this.transcriptDecorationWidth : 0;
    }
    return splitToolTranscriptRow(this, lines, width, gutterWidths);
  }
}
