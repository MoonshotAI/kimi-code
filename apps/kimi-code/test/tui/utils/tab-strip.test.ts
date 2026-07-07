import { describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { darkColors } from '#/tui/theme/colors';
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
  // Cell widths: ` ${label} ` → 11 / 10 / 13 / 8 = 42, plus 3 separators and a
  // leading space → 46 columns total.
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
    // Regression: the old fit check summed only cell widths and ignored the
    // three inter-tab spaces, so at 43–45 columns it declared a fit while the
    // joined line was wider and the trailing tab got truncated.
    const out = render(labels, FULL_WIDTH);
    expect(out.endsWith(' Custom ')).toBe(true);
  });
});
