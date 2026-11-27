import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import {
  ANSI_ESCAPE_PATTERN,
  TAIL_WINDOW_UNITS_PER_CELL,
  TRUNCATION_ELLIPSIS,
} from '#/tui/constant/rendering';

export interface HeaderFlex {
  readonly text: string;
  readonly style?: (text: string) => string;
  readonly keep: 'head' | 'tail';
}

export interface HeaderSegments {
  readonly head: string;
  readonly flex: HeaderFlex;
  readonly tail: string;
}

export type HeaderContent = string | HeaderSegments;

interface TextUnit {
  readonly text: string;
  readonly width: number;
}

function* textUnits(text: string): Generator<TextUnit> {
  const segmenter = new Intl.Segmenter();
  let offset = 0;
  for (const match of text.matchAll(ANSI_ESCAPE_PATTERN)) {
    if (match.index > offset) {
      for (const segment of segmenter.segment(text.slice(offset, match.index))) {
        yield { text: segment.segment, width: visibleWidth(segment.segment) };
      }
    }
    yield { text: match[0], width: 0 };
    offset = match.index + match[0].length;
  }
  for (const segment of segmenter.segment(text.slice(offset))) {
    yield { text: segment.segment, width: visibleWidth(segment.segment) };
  }
}

function keepHead(text: string, width: number): string {
  const budget = width - visibleWidth(TRUNCATION_ELLIPSIS);
  let out = '';
  let used = 0;
  let truncated = false;
  for (const unit of textUnits(text)) {
    if (used + unit.width > budget) {
      truncated = true;
      break;
    }
    out += unit.text;
    used += unit.width;
  }
  return truncated ? `${out}${TRUNCATION_ELLIPSIS}` : out;
}

function keepTail(text: string, width: number): string {
  const budget = width - visibleWidth(TRUNCATION_ELLIPSIS);
  const window = budget * TAIL_WINDOW_UNITS_PER_CELL + 64;
  const windowed = text.length > window ? text.slice(-window) : text;
  const units = [...textUnits(windowed)];
  if (windowed.length < text.length) units.shift();
  let out = '';
  let used = 0;
  let truncated = windowed.length < text.length;
  for (const unit of units.toReversed()) {
    if (used + unit.width > budget) {
      truncated = true;
      break;
    }
    out = unit.text + out;
    used += unit.width;
  }
  return truncated ? `${TRUNCATION_ELLIPSIS}${out}` : out;
}

function fits(text: string, width: number): boolean {
  let used = 0;
  for (const unit of textUnits(text)) {
    used += unit.width;
    if (used > width) return false;
  }
  return true;
}

function fitFlex(flex: HeaderFlex, width: number): string {
  if (fits(flex.text, width)) return flex.text;
  return flex.keep === 'tail' ? keepTail(flex.text, width) : keepHead(flex.text, width);
}

function layoutHeaderContent(
  content: HeaderContent,
  width: number,
): { line: string; truncated: boolean } {
  const safeWidth = Math.max(1, width);
  if (typeof content === 'string') {
    return {
      line: truncateToWidth(content, safeWidth, TRUNCATION_ELLIPSIS),
      truncated: visibleWidth(content) > safeWidth,
    };
  }
  const { head, flex, tail } = content;
  const style = flex.style ?? ((text: string) => text);
  const available = safeWidth - visibleWidth(head) - visibleWidth(tail);
  if (available < 2) {
    const headWidth = visibleWidth(head);
    const tailWidth = visibleWidth(tail);
    if (headWidth + tailWidth <= safeWidth) {
      const marker =
        flex.text.length > 0 && safeWidth - headWidth - tailWidth >= 1
          ? style(TRUNCATION_ELLIPSIS)
          : '';
      return { line: `${head}${marker}${tail}`, truncated: flex.text.length > 0 };
    }
    if (safeWidth - tailWidth >= 2) {
      return {
        line: `${truncateToWidth(head, safeWidth - tailWidth, TRUNCATION_ELLIPSIS)}${tail}`,
        truncated: true,
      };
    }
    return {
      line: truncateToWidth(`${head}${tail}`, safeWidth, TRUNCATION_ELLIPSIS),
      truncated: true,
    };
  }
  const fitted = fitFlex(flex, available);
  return { line: `${head}${style(fitted)}${tail}`, truncated: fitted !== flex.text };
}

export function renderHeaderContent(content: HeaderContent, width: number): string {
  return layoutHeaderContent(content, width).line;
}

function sameContent(a: HeaderContent, b: HeaderContent): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return (
    a.head === b.head &&
    a.tail === b.tail &&
    a.flex.text === b.flex.text &&
    a.flex.keep === b.flex.keep &&
    a.flex.style === b.flex.style
  );
}

export class TruncatedHeaderLine implements Component {
  private cache:
    | { content: HeaderContent; width: number; lines: string[]; truncated: boolean }
    | undefined;

  constructor(
    private content: HeaderContent,
    private readonly decorationWidth = 0,
  ) {}

  selectionExclusions(width: number) {
    return this.decorationWidth === 0
      ? []
      : [{ start: 0, end: Math.min(this.decorationWidth, Math.max(0, width)) }];
  }

  setText(content: HeaderContent): void {
    if (sameContent(this.content, content)) return;
    this.content = content;
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  wasTruncated(): boolean {
    return this.cache?.truncated ?? false;
  }

  render(width: number): string[] {
    const cache = this.cache;
    if (cache !== undefined && cache.content === this.content && cache.width === width) {
      return cache.lines;
    }
    const { line, truncated } = layoutHeaderContent(this.content, width);
    const lines = [line];
    this.cache = { content: this.content, width, lines, truncated };
    return lines;
  }
}
