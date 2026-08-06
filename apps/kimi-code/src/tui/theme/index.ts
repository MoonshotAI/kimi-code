/**
 * Theme system public API.
 */

import { getBasicPalette, getBuiltInPalette } from './colors';
import type { ColorPalette, ResolvedTheme } from './colors';
import { loadCustomThemeMerged } from './custom-theme-loader';
import { detectTerminalTheme, isBasicColorTerminal } from './detect';

export { currentTheme, Theme } from './theme';
export type { ColorToken } from './theme';
export { darkColors, lightColors, getBuiltInPalette } from './colors';
export type { ColorPalette, ResolvedTheme } from './colors';
export { detectTerminalTheme, isBasicColorTerminal } from './detect';
export { loadCustomTheme, loadCustomThemeMerged, listCustomThemes } from './custom-theme-loader';

/**
 * User-facing theme preference.
 * `'auto'` defers to terminal background detection at startup.
 * `'dark'` / `'light'` are explicit built-in overrides.
 * Any other string is treated as a custom theme name looked up in
 * `~/.kimi-code/themes/<name>.json`.
 */
export type BuiltInTheme = 'dark' | 'light' | 'auto';
export type ThemeName = BuiltInTheme | (string & {});

export function isBuiltInTheme(value: string): value is BuiltInTheme {
  return value === 'dark' || value === 'light' || value === 'auto';
}

export function isThemeName(_value: string): _value is ThemeName {
  return true; // any string is a valid theme name (custom themes)
}

/**
 * Resolve a user preference to a concrete palette.
 *
 * - `'auto'` triggers terminal background detection.
 * - `'dark'` / `'light'` return the built-in palette.
 * - Any other string loads a custom theme from `~/.kimi-code/themes/`;
 *   missing / invalid files fall back to dark palette.
 *
 * Built-in palettes are swapped for their ANSI-16 `basic*` variants on
 * terminals that only support basic colors (`isBasicColorTerminal`); custom
 * themes always load as written.
 */
export async function getColorPalette(theme: ThemeName): Promise<ColorPalette> {
  if (theme === 'light') return getBuiltInPaletteForTerminal('light');
  if (theme === 'dark') return getBuiltInPaletteForTerminal('dark');
  if (theme === 'auto') {
    const detected = await detectTerminalTheme();
    return getBuiltInPaletteForTerminal(detected);
  }
  // custom theme
  const custom = await loadCustomThemeMerged(theme);
  return custom ?? getBuiltInPaletteForTerminal('dark');
}

/**
 * Synchronous fallback used by paths that cannot wait on terminal probes.
 * `'auto'` collapses to `'dark'`; explicit choices pass through.
 * Custom themes are not supported here — falls back to dark.
 */
export function getColorPaletteSync(theme: ThemeName): ColorPalette {
  if (theme === 'light') return getBuiltInPaletteForTerminal('light');
  return getBuiltInPaletteForTerminal('dark');
}

/** Built-in palette lookup with the ANSI-16 fallback applied. */
export function getBuiltInPaletteForTerminal(resolved: ResolvedTheme): ColorPalette {
  return isBasicColorTerminal() ? getBasicPalette(resolved) : getBuiltInPalette(resolved);
}
