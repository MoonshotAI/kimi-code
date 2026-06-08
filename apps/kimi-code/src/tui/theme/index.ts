/**
 * Theme system public API.
 */

import type { ResolvedTheme } from './colors';
import { detectTerminalTheme } from './detect';

export { darkColors, lightColors, getColorPalette } from './colors';
export type { ColorPalette, ResolvedTheme } from './colors';
export { createThemeStyles } from './styles';
export type { ThemeStyles } from './styles';
export { gradientText } from './gradient-text';
export { createMarkdownTheme, createEditorTheme } from './pi-tui-theme';
export { detectTerminalTheme } from './detect';

/**
 * User-facing theme preference. `'auto'` defers to terminal background
 * detection at startup; `'dark'` / `'light'` are explicit overrides that
 * never trigger detection. The persisted value in `tui.toml` is always
 * one of these three; the detected `ResolvedTheme` is computed at
 * startup and held only in memory.
 */
export type Theme = 'dark' | 'light' | 'auto';

export function isTheme(value: string): value is Theme {
  return value === 'dark' || value === 'light' || value === 'auto';
}

/**
 * Resolve a user preference to a concrete palette key. `'auto'` triggers
 * terminal background detection (OSC 11 with COLORFGBG / dark fallback);
 * explicit choices pass through.
 */
export async function resolveTheme(theme: Theme): Promise<ResolvedTheme> {
  if (theme === 'auto') return detectTerminalTheme();
  return theme;
}

/**
 * Synchronous fallback used by paths that cannot wait on terminal probes
 * (initial state construction, in-TUI theme switches). `'auto'` collapses
 * to `'dark'`; explicit choices pass through.
 */
export function resolveThemeSync(theme: Theme): ResolvedTheme {
  if (theme === 'auto') return 'dark';
  return theme;
}
