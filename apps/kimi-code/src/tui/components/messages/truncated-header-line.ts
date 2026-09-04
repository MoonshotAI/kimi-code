/**
 * Single-row line shared by the tool card header, the Read group header and
 * the collapsed card's outcome row.
 *
 * A header is either a plain string, truncated at the render width, or three
 * segments: a fixed head (bullet + label), a flexible middle (command, update
 * preview, key argument) and a fixed tail (the result chip). The middle gets
 * whatever width is left after the head and the tail, so on a wide terminal
 * it fills the row and on a narrow one the chip still survives. `keep`
 * decides which end of the middle survives a cut: commands keep their start,
 * paths keep their file name.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { TRUNCATION_ELLIPSIS } from '#/tui/constant/rendering';

export interface HeaderFlex {
  /** Plain text; `style` is applied after the cut so the ellipsis is styled too. */
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

// The middle is plain text and gets styled after the cut, so it is cut by
// hand here: pi-tui's truncateToWidth wraps its ellipsis in a reset sequence,
// which would break the caller's styling around it.

// ANSI escape sequences (CSI, OSC) — tool output can carry them — are
// zero-width atomic units: a cut must neither count their bytes toward the
// budget nor split a sequence in half and leak a malformed one.
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

interface TextUnit {
  readonly text: string;
  readonly width: number;
}

/** Grapheme clusters and whole escape sequences, in order; escape sequences measure zero width. */
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

/** Keep the start of `text` up to a trailing ellipsis, within `width` cells. */
function keepHead(text: string, width: number): string {
  const budget = width - visibleWidth(TRUNCATION_ELLIPSIS);
  let out = '';
  let used = 0;
  let truncated = false;
  // Lazy iteration: only about one row of clusters is ever walked, so a huge
  // argument (a base64 payload in an MCP call) costs nothing here.
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

/** Keep the end of `text` behind a leading ellipsis, within `width` cells. */
function keepTail(text: string, width: number): string {
  const budget = width - visibleWidth(TRUNCATION_ELLIPSIS);
  // One cell needs at most one code unit of payload; the window adds headroom
  // only for zero-width escape sequences, so the segmented slice stays
  // bounded by the terminal width instead of the whole argument.
  const windowed = text.length > budget + 64 ? text.slice(-(budget + 64)) : text;
  const units = [...textUnits(windowed)];
  // The window edge may have split a grapheme or an escape sequence; drop
  // whatever partial unit it left behind the leading ellipsis.
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

function fitFlex(flex: HeaderFlex, width: number): string {
  // Two cells per code unit is the worst case (wide chars), so beyond twice
  // the width a cut is certain and the whole string is never measured.
  if (flex.text.length <= width * 2 && visibleWidth(flex.text) <= width) return flex.text;
  return flex.keep === 'tail' ? keepTail(flex.text, width) : keepHead(flex.text, width);
}

export function renderHeaderContent(content: HeaderContent, width: number): string {
  const safeWidth = Math.max(1, width);
  if (typeof content === 'string') return truncateToWidth(content, safeWidth, TRUNCATION_ELLIPSIS);
  const { head, flex, tail } = content;
  const style = flex.style ?? ((text: string) => text);
  const available = safeWidth - visibleWidth(head) - visibleWidth(tail);
  // Below two cells there is no room for even an ellipsis plus one character
  // of the middle: give up on the layout and cut the whole row from the end.
  if (available < 2) {
    return truncateToWidth(`${head}${style(flex.text)}${tail}`, safeWidth, TRUNCATION_ELLIPSIS);
  }
  return `${head}${style(fitFlex(flex, available))}${tail}`;
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
  // The card and the gutter container reuse a child's output by array
  // identity, so an unchanged header must hand back the same array — a fresh
  // one per frame would defeat both caches on every paint.
  private cache: { content: HeaderContent; width: number; lines: string[] } | undefined;

  constructor(private content: HeaderContent) {}

  setText(content: HeaderContent): void {
    if (sameContent(this.content, content)) return;
    this.content = content;
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const cache = this.cache;
    if (cache !== undefined && cache.content === this.content && cache.width === width) {
      return cache.lines;
    }
    const lines = [renderHeaderContent(this.content, width)];
    this.cache = { content: this.content, width, lines };
    return lines;
  }
}
