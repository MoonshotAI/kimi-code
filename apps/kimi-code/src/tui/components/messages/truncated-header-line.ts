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

const ELLIPSIS = '…';

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

/** Grapheme clusters, so an emoji or a combining sequence is never split by a cut. */
function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter().segment(text), (segment) => segment.segment);
}

/** Keep the start of `text` up to a trailing ellipsis, within `width` cells. */
function keepHead(text: string, width: number): string {
  const budget = width - visibleWidth(ELLIPSIS);
  let out = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    const clusterWidth = visibleWidth(cluster);
    if (used + clusterWidth > budget) break;
    out += cluster;
    used += clusterWidth;
  }
  return `${out}${ELLIPSIS}`;
}

/** Keep the end of `text` behind a leading ellipsis, within `width` cells. */
function keepTail(text: string, width: number): string {
  const budget = width - visibleWidth(ELLIPSIS);
  let out = '';
  let used = 0;
  for (const cluster of graphemes(text).toReversed()) {
    const clusterWidth = visibleWidth(cluster);
    if (used + clusterWidth > budget) break;
    out = cluster + out;
    used += clusterWidth;
  }
  return `${ELLIPSIS}${out}`;
}

function fitFlex(flex: HeaderFlex, width: number): string {
  if (visibleWidth(flex.text) <= width) return flex.text;
  return flex.keep === 'tail' ? keepTail(flex.text, width) : keepHead(flex.text, width);
}

export function renderHeaderContent(content: HeaderContent, width: number): string {
  const safeWidth = Math.max(1, width);
  if (typeof content === 'string') return truncateToWidth(content, safeWidth, ELLIPSIS);
  const { head, flex, tail } = content;
  const style = flex.style ?? ((text: string) => text);
  const available = safeWidth - visibleWidth(head) - visibleWidth(tail);
  // Below two cells there is no room for even an ellipsis plus one character
  // of the middle: give up on the layout and cut the whole row from the end.
  if (available < 2) {
    return truncateToWidth(`${head}${style(flex.text)}${tail}`, safeWidth, ELLIPSIS);
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
