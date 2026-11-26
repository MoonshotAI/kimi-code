import { describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { contrastRatio, contrastingTextColor } from '#/tui/theme/color-mix';
import { darkColors, lightColors } from '#/tui/theme/colors';
import { renderTabStrip } from '#/tui/utils/tab-strip';

const ANSI_SGR = /\u001b\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
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
});
