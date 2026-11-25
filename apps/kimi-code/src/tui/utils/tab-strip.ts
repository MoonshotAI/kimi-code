import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { contrastingTextColor } from '#/tui/theme/color-mix';
import type { ColorPalette } from '#/tui/theme/colors';
import {
  renderInlineSegments,
  type InlineSegment,
  type InlineTarget,
} from '#/tui/utils/mouse-regions';

export interface TabStripOptions {
  readonly labels: readonly string[];
  readonly activeIndex: number;
  readonly width: number;
  readonly colors: ColorPalette;
}

export type RenderTabStripOptions = TabStripOptions;

export type TabStripHit =
  | { readonly kind: 'tab'; readonly index: number }
  | { readonly kind: 'prev' }
  | { readonly kind: 'next' };

export interface TabStripHitRange {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface TabStripLayout {
  readonly line: string;
  readonly targets: readonly InlineTarget<TabStripHit>[];
  readonly hitRanges: readonly TabStripHitRange[];
}

function styleTab(label: string, isActive: boolean, colors: ColorPalette): string {
  const cell = ` ${label} `;
  return isActive
    ? chalk.bgHex(colors.primary).hex(contrastingTextColor(colors.primary)).bold(cell)
    : chalk.hex(colors.textMuted)(cell);
}

function buildTabStripLayout(
  inline: readonly InlineSegment<TabStripHit>[],
  width: number,
): TabStripLayout {
  const rendered = renderInlineSegments(inline, width);
  const hitRanges: TabStripHitRange[] = [];
  for (const target of rendered.targets) {
    if (target.value.kind === 'tab') {
      hitRanges.push({ index: target.value.index, start: target.start, end: target.end });
    }
  }
  return { ...rendered, hitRanges };
}

export function resolveTabStripHit(hit: TabStripHit, activeIndex: number, tabCount: number): number {
  if (tabCount <= 0) return 0;
  const clampedActive = Math.min(Math.max(0, activeIndex), tabCount - 1);
  switch (hit.kind) {
    case 'tab':
      return Math.min(Math.max(0, hit.index), tabCount - 1);
    case 'prev':
      return Math.max(0, clampedActive - 1);
    case 'next':
      return Math.min(tabCount - 1, clampedActive + 1);
  }
}

export function layoutTabStrip(opts: TabStripOptions): TabStripLayout {
  const { labels, activeIndex, width, colors } = opts;
  const styled = labels.map((label, i) => styleTab(label, i === activeIndex, colors));

  const totalSegmentWidth = styled.reduce((sum, s) => sum + visibleWidth(s), 0);
  const fullSeparatorWidth = Math.max(0, styled.length - 1);
  if (1 + totalSegmentWidth + fullSeparatorWidth <= width) {
    const inline: InlineSegment<TabStripHit>[] = [{ text: ' ' }];
    for (let i = 0; i < styled.length; i++) {
      if (i > 0) inline.push({ text: ' ' });
      inline.push({ text: styled[i]!, value: { kind: 'tab', index: i } });
    }
    return buildTabStripLayout(inline, width);
  }

  const segmentWidths = styled.map((s) => visibleWidth(s));
  const safeActive = labels.length === 0 ? 0 : Math.min(Math.max(0, activeIndex), labels.length - 1);
  let start = safeActive;
  let end = labels.length === 0 ? 0 : safeActive + 1;
  let contentWidth = segmentWidths[safeActive] ?? 0;

  const fits = (s: number, e: number, cw: number): boolean => {
    const needLeft = s > 0;
    const needRight = e < styled.length;
    const frameWidth = (needLeft ? 2 : 1) + (needRight ? 2 : 0);
    const separators = Math.max(0, e - s - 1);
    return cw + separators + frameWidth <= width;
  };

  while (true) {
    const leftW = start > 0 ? segmentWidths[start - 1]! : Infinity;
    const rightW = end < styled.length ? segmentWidths[end]! : Infinity;
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
  const hasRight = end < styled.length;
  const inline: InlineSegment<TabStripHit>[] = [
    hasLeft ? { text: chalk.hex(colors.textMuted)('< '), value: { kind: 'prev' } } : { text: ' ' },
  ];
  for (let i = start; i < end; i++) {
    if (i > start) inline.push({ text: ' ' });
    inline.push({ text: styled[i]!, value: { kind: 'tab', index: i } });
  }
  if (hasRight) {
    inline.push({ text: chalk.hex(colors.textMuted)(' >'), value: { kind: 'next' } });
  }
  return buildTabStripLayout(inline, width);
}

export function renderTabStrip(opts: TabStripOptions): string {
  return layoutTabStrip(opts).line;
}
