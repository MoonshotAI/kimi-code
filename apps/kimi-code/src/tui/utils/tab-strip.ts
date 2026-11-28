import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { contrastingTextColor } from '#/tui/theme/color-mix';
import type { ColorPalette } from '#/tui/theme/colors';

export interface RenderTabStripOptions {
  readonly labels: readonly string[];
  readonly activeIndex: number;
  readonly width: number;
  readonly colors: ColorPalette;
}

export interface LayoutStyledTabStripOptions {
  readonly segments: readonly string[];
  readonly activeIndex: number;
  readonly width: number;
  readonly separator?: string;
  readonly styleMarker: (text: string) => string;
}

function styleTab(label: string, isActive: boolean, colors: ColorPalette): string {
  const cell = ` ${label} `;
  return isActive
    ? chalk.bgHex(colors.primary).hex(contrastingTextColor(colors.primary)).bold(cell)
    : chalk.hex(colors.textMuted)(cell);
}

export interface TabStripHitRange {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface TabStripLayout {
  readonly line: string;
  readonly hitRanges: readonly TabStripHitRange[];
}

export function layoutStyledTabStrip(opts: LayoutStyledTabStripOptions): TabStripLayout {
  const { segments, activeIndex, width, separator = ' ', styleMarker } = opts;
  if (segments.length === 0) return { line: '', hitRanges: [] };
  const sepWidth = visibleWidth(separator);
  const segmentWidths = segments.map((segment) => visibleWidth(segment));

  const totalSegmentWidth = segmentWidths.reduce((sum, w) => sum + w, 0);
  const fullSeparatorWidth = Math.max(0, segments.length - 1) * sepWidth;
  if (1 + totalSegmentWidth + fullSeparatorWidth <= width) {
    const hitRanges: TabStripHitRange[] = [];
    let col = 1;
    for (let i = 0; i < segments.length; i++) {
      const w = segmentWidths[i]!;
      hitRanges.push({ index: i, start: col, end: col + w });
      col += w + sepWidth;
    }
    return { line: ' ' + segments.join(separator), hitRanges };
  }

  const clampedActive = Math.max(0, Math.min(activeIndex, segments.length - 1));
  let start = clampedActive;
  let end = clampedActive + 1;
  let contentWidth = segmentWidths[clampedActive] ?? 0;

  const fits = (s: number, e: number, cw: number): boolean => {
    const needLeft = s > 0;
    const needRight = e < segments.length;
    const frameWidth = (needLeft ? 2 : 1) + (needRight ? 2 : 0);
    const separators = Math.max(0, e - s - 1) * sepWidth;
    return cw + separators + frameWidth <= width;
  };

  while (true) {
    const leftW = start > 0 ? segmentWidths[start - 1]! : Infinity;
    const rightW = end < segments.length ? segmentWidths[end]! : Infinity;
    if (leftW === Infinity && rightW === Infinity) break;

    if (leftW <= rightW) {
      if (fits(start - 1, end, contentWidth + leftW)) {
        contentWidth += leftW;
        start--;
      } else if (fits(start, end + 1, contentWidth + rightW)) {
        contentWidth += rightW;
        end++;
      } else {
        break;
      }
    } else if (fits(start, end + 1, contentWidth + rightW)) {
      contentWidth += rightW;
      end++;
    } else if (fits(start - 1, end, contentWidth + leftW)) {
      contentWidth += leftW;
      start--;
    } else {
      break;
    }
  }

  const hasLeft = start > 0;
  const hasRight = end < segments.length;
  const leftWidth = hasLeft ? 2 : 1;
  const rightWidth = hasRight ? 2 : 0;
  const maxSingleWidth = Math.max(1, width - leftWidth - rightWidth);

  const hitRanges: TabStripHitRange[] = [];
  if (hasLeft && width >= 2) {
    hitRanges.push({ index: start - 1, start: 0, end: 2 });
  }
  let col = leftWidth;
  const renderedSlice: string[] = [];
  for (let i = start; i < end; i++) {
    if (i > start) col += sepWidth;
    const raw = segments[i]!;
    const seg =
      end - start === 1 && segmentWidths[i]! > maxSingleWidth
        ? truncateToWidth(raw, maxSingleWidth)
        : raw;
    const w = visibleWidth(seg);
    if (col < width) {
      hitRanges.push({ index: i, start: col, end: Math.min(width, col + w) });
    }
    col += w;
    renderedSlice.push(seg);
  }
  if (hasRight && col < width) {
    hitRanges.push({ index: end, start: col, end: Math.min(width, col + rightWidth) });
  }

  let strip = hasLeft ? styleMarker('< ') : ' ';
  strip += renderedSlice.join(separator);
  if (hasRight) strip += styleMarker(' >');
  return { line: strip, hitRanges };
}

export function layoutTabStrip(opts: RenderTabStripOptions): TabStripLayout {
  const { labels, activeIndex, width, colors } = opts;
  return layoutStyledTabStrip({
    segments: labels.map((label, i) => styleTab(label, i === activeIndex, colors)),
    activeIndex,
    width,
    styleMarker: (text) => chalk.hex(colors.textMuted)(text),
  });
}

export function renderTabStrip(opts: RenderTabStripOptions): string {
  return layoutTabStrip(opts).line;
}
