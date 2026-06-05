/**
 * Theme system public API.
 */

export { currentTheme, Theme } from './theme';
export type { ColorToken } from './theme';
export { darkColors, lightColors, getBuiltInPalette } from './colors';
export type { ColorPalette, ResolvedTheme } from './colors';
export { detectTerminalTheme } from './detect';
export { loadCustomTheme, loadCustomThemeMerged, listCustomThemes } from './custom-theme-loader';

import { detectTerminalTheme } from './detect';
import { getBuiltInPalette } from './colors';
import { loadCustomThemeMerged } from './custom-theme-loader';
import type { ColorPalette, ResolvedTheme } from './colors';

/**
 * User-facing theme preference.
 * `'auto'` defers to terminal background detection at startup.
 * `'dark'` / `'light'` are explicit built-in overrides.
 * Any other string is treated as a custom theme name looked up in
 * `~/.kimi-code/themes/<name>.json`.
 */
export type BuiltInTheme = 'dark' | 'light' | 'auto';
export type ThemeName = BuiltInTheme | string;

export function isBuiltInTheme(value: string): value is BuiltInTheme {
  return value === 'dark' || value === 'light' || value === 'auto';
}

export function isThemeName(value: string): value is ThemeName {
  return true; // any string is a valid theme name (custom themes)
}

/**
 * Resolve a user preference to a concrete palette.
 *
 * - `'auto'` triggers terminal background detection.
 * - `'dark'` / `'light'` return the built-in palette.
 * - Any other string loads a custom theme from `~/.kimi-code/themes/`;
 *   missing / invalid files fall back to dark palette.
 */
export async function getColorPalette(theme: ThemeName): Promise<ColorPalette> {
  if (theme === 'light') return getBuiltInPalette('light');
  if (theme === 'dark') return getBuiltInPalette('dark');
  if (theme === 'auto') {
    const detected = await detectTerminalTheme();
    return getBuiltInPalette(detected);
  }
  // custom theme
  const custom = await loadCustomThemeMerged(theme);
  return custom ?? getBuiltInPalette('dark');
}

/**
 * Synchronous fallback used by paths that cannot wait on terminal probes.
 * `'auto'` collapses to `'dark'`; explicit choices pass through.
 * Custom themes are not supported here — falls back to dark.
 */
export function getColorPaletteSync(theme: ThemeName): ColorPalette {
  if (theme === 'light') return getBuiltInPalette('light');
  return getBuiltInPalette('dark');
}
