import { describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { contrastRatio, contrastingTextColor } from '#/tui/theme/color-mix';
import { darkColors, lightColors } from '#/tui/theme/colors';
import {
  layoutTabStrip,
  renderTabStrip,
  resolveTabStripHit,
  type TabStripLayout,
} from '#/tui/utils/tab-strip';

const ANSI_SGR = /\u001b\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function layout(labels: readonly string[], width: number, activeIndex = 0): TabStripLayout {
  const previousChalkLevel = chalk.level;
  chalk.level = 3;
  try {
    return layoutTabStrip({ labels, activeIndex, width, colors: darkColors });
  } finally {
    chalk.level = previousChalkLevel;
  }
}

function render(labels: readonly string[], width: number, activeIndex = 0): string {
  const previousChalkLevel = chalk.level;
  chalk.level = 3;
  try {
    return strip(renderTabStrip({ labels, activeIndex, width, colors: darkColors }));
  } finally {
    chalk.level = previousChalkLevel;
  }
}

describe('renderTabStrip', () => {
  const labels = ['Installed', 'Official', 'Third-party', 'Custom'];
  const FULL_WIDTH = 46;

  it('shows the full strip when it exactly fits', () => {
    const out = render(labels, FULL_WIDTH);
    expect(out).toContain('Installed');
    expect(out).toContain('Custom');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('scrolls (shows markers) when one column narrower than full fit', () => {
    const out = render(labels, FULL_WIDTH - 1, 0);
    expect(out).toContain('>');
    expect(out).not.toContain('Custom');
  });

  it('does not truncate the last tab when separators just barely fit', () => {
    const out = render(labels, FULL_WIDTH);
    expect(out.endsWith(' Custom ')).toBe(true);
  });

  it('uses a high-contrast foreground color for the active tab in both light and dark palettes', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    try {
      const lightOut = renderTabStrip({
        labels: ['Cwd', 'Project', 'All'],
        activeIndex: 0,
        width: 40,
        colors: lightColors,
      });
      const lightText = contrastingTextColor(lightColors.primary);
      expect(lightText).toBe('#FFFFFF');
      expect(contrastRatio(lightColors.primary, lightText)).toBeGreaterThanOrEqual(4.5);
      expect(lightOut).toContain(chalk.bgHex(lightColors.primary).hex('#FFFFFF').bold(' Cwd '));

      const darkOut = renderTabStrip({
        labels: ['Cwd', 'Project', 'All'],
        activeIndex: 0,
        width: 40,
        colors: darkColors,
      });
      const darkText = contrastingTextColor(darkColors.primary);
      expect(darkText).toBe('#000000');
      expect(contrastRatio(darkColors.primary, darkText)).toBeGreaterThanOrEqual(4.5);
      expect(darkOut).toContain(chalk.bgHex(darkColors.primary).hex('#000000').bold(' Cwd '));
    } finally {
      chalk.level = previousChalkLevel;
    }
  });

  it('produces exact column targets and hitRanges for full-fit and overflowing strips matching renderTabStrip', () => {
    const full = layout(labels, FULL_WIDTH, 0);
    const plainFull = strip(full.line);
    expect(plainFull).toBe(render(labels, FULL_WIDTH, 0));
    expect(full.targets.map((t) => [t.value, plainFull.slice(t.start, t.end)])).toEqual([
      [{ kind: 'tab', index: 0 }, ' Installed '],
      [{ kind: 'tab', index: 1 }, ' Official '],
      [{ kind: 'tab', index: 2 }, ' Third-party '],
      [{ kind: 'tab', index: 3 }, ' Custom '],
    ]);
    expect(full.hitRanges.map((r) => [r.index, plainFull.slice(r.start, r.end)])).toEqual([
      [0, ' Installed '],
      [1, ' Official '],
      [2, ' Third-party '],
      [3, ' Custom '],
    ]);

    const rightOverflow = layout(labels, 26, 1);
    const plainRight = strip(rightOverflow.line);
    expect(plainRight).toBe(render(labels, 26, 1));
    expect(plainRight.startsWith('< ')).toBe(false);
    expect(plainRight.endsWith(' >')).toBe(true);
    expect(rightOverflow.targets.at(-1)).toEqual({
      start: plainRight.length - 2,
      end: plainRight.length,
      value: { kind: 'next' },
    });

    const bothOverflow = layout(labels, 20, 2);
    const plainBoth = strip(bothOverflow.line);
    expect(plainBoth).toBe(render(labels, 20, 2));
    expect(plainBoth.startsWith('< ')).toBe(true);
    expect(plainBoth.endsWith(' >')).toBe(true);
    expect(bothOverflow.targets.map((t) => [t.value, plainBoth.slice(t.start, t.end)])).toEqual([
      [{ kind: 'prev' }, '< '],
      [{ kind: 'tab', index: 2 }, ' Third-party '],
      [{ kind: 'next' }, ' >'],
    ]);
    expect(bothOverflow.hitRanges.map((r) => [r.index, plainBoth.slice(r.start, r.end)])).toEqual([
      [2, ' Third-party '],
    ]);

    const leftOverflow = layout(labels, 20, 3);
    const plainLeft = strip(leftOverflow.line);
    expect(plainLeft).toBe(render(labels, 20, 3));
    expect(plainLeft.startsWith('< ')).toBe(true);
    expect(plainLeft.endsWith(' >')).toBe(false);
    expect(leftOverflow.targets[0]).toEqual({ start: 0, end: 2, value: { kind: 'prev' } });
  });

  it('resolves tab, prev, and next hits with safe bounds', () => {
    expect(resolveTabStripHit({ kind: 'tab', index: 2 }, 0, 4)).toBe(2);
    expect(resolveTabStripHit({ kind: 'tab', index: 99 }, 0, 4)).toBe(3);
    expect(resolveTabStripHit({ kind: 'prev' }, 2, 4)).toBe(1);
    expect(resolveTabStripHit({ kind: 'prev' }, 0, 4)).toBe(0);
    expect(resolveTabStripHit({ kind: 'next' }, 2, 4)).toBe(3);
    expect(resolveTabStripHit({ kind: 'next' }, 3, 4)).toBe(3);
    expect(resolveTabStripHit({ kind: 'next' }, 0, 0)).toBe(0);
  });
});
