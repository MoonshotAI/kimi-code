import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface RenderTabStripOptions {
  readonly labels: readonly string[];
  readonly activeIndex: number;
  readonly width: number;
  readonly colors: ColorPalette;
}

function styleTab(label: string, isActive: boolean, colors: ColorPalette): string {
  const cell = ` ${label} `;
  return isActive
    ? chalk.bgHex(colors.primary).hex(colors.text).bold(cell)
    : chalk.hex(colors.textMuted)(cell);
}

export function renderTabStrip(opts: RenderTabStripOptions): string {
  const { labels, activeIndex, width, colors } = opts;
  const segments = labels.map((label, i) => styleTab(label, i === activeIndex, colors));

  const totalSegmentWidth = segments.reduce((sum, s) => sum + visibleWidth(s), 0);
  const fullSeparatorWidth = Math.max(0, segments.length - 1);
  if (1 + totalSegmentWidth + fullSeparatorWidth <= width) {
    return ' ' + segments.join(' ');
  }

  const segmentWidths = segments.map((s) => visibleWidth(s));
  let start = activeIndex;
  let end = activeIndex + 1;
  let contentWidth = segmentWidths[activeIndex] ?? 0;

  const fits = (s: number, e: number, cw: number): boolean => {
    const needLeft = s > 0;
    const needRight = e < segments.length;
    const frameWidth = (needLeft ? 2 : 1) + (needRight ? 2 : 0);
    const separators = Math.max(0, e - s - 1);
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
  let strip = hasLeft ? chalk.hex(colors.textMuted)('< ') : ' ';
  strip += segments.slice(start, end).join(' ');
  if (hasRight) {
    strip += chalk.hex(colors.textMuted)(' >');
  }
  return strip;
}
