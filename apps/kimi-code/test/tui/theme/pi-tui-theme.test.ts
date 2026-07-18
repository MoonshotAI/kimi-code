import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { darkColors, lightColors } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { currentTheme } from '#/tui/theme/theme';

// The pi-tui theme adapters wrap output with `chalk`. Under vitest chalk
// defaults to level 0 (no color) because there's no TTY, which would strip
// every SGR from the output we want to assert on. Force truecolor for the
// duration of this file, matching the pattern used in banner/footer/server
// tests elsewhere.
const previousChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

describe('createMarkdownTheme', () => {
  it('emits the textStrong hex for bold spans so themes actually govern bold (#1872)', () => {
    // Regression for #1872. Before the fix, `bold` was `chalk.bold(text)` —
    // it emitted only the SGR bold code, no fg color, so most terminals
    // rendered bold as a dim gray on dark backgrounds, ignoring the theme's
    // `textStrong` token. Assert bold now carries the token's hex.
    const previousPalette = currentTheme.palette;
    try {
      currentTheme.setPalette(darkColors);
      const theme = createMarkdownTheme();
      const output = theme.bold('hello');
      // chalk.hex('#F5F5F5') → foreground truecolor SGR `[38;2;245;245;245m`.
      expect(output).toContain('[38;2;245;245;245m');
      // Still bold — no regression on the SGR bold code.
      expect(output).toContain('[1m');
      expect(output).toContain('hello');
    } finally {
      currentTheme.setPalette(previousPalette);
    }
  });

  it('follows the active palette when the theme changes (#1872)', () => {
    // Guards against a future refactor that reads `textStrong` once at
    // theme-factory time instead of at each call — `createMarkdownTheme` must
    // stay reactive to `currentTheme.setPalette()` so `/reload-tui` picks up
    // custom themes.
    const previousPalette = currentTheme.palette;
    try {
      const theme = createMarkdownTheme();
      currentTheme.setPalette(darkColors);
      const dark = theme.bold('x');
      currentTheme.setPalette(lightColors);
      const light = theme.bold('x');
      // Different textStrong on the two palettes → different foreground SGR.
      expect(dark).not.toBe(light);
    } finally {
      currentTheme.setPalette(previousPalette);
    }
  });
});
