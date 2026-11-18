import { getBuiltInPalette } from './colors';
import type { ColorPalette, ResolvedTheme } from './colors';
import { loadCustomThemeMerged } from './custom-theme-loader';
import { detectTerminalTheme } from './detect';

export { currentTheme, Theme } from './theme';
export type { ColorToken } from './theme';
export { darkColors, lightColors, getBuiltInPalette } from './colors';
export type { ColorPalette, ResolvedTheme } from './colors';
export { detectTerminalTheme } from './detect';
export { loadCustomTheme, loadCustomThemeMerged, listCustomThemes } from './custom-theme-loader';

export type BuiltInTheme = 'dark' | 'light' | 'auto';
export type ThemeName = BuiltInTheme | (string & {});

export function isBuiltInTheme(value: string): value is BuiltInTheme {
  return value === 'dark' || value === 'light' || value === 'auto';
}

export function isThemeName(_value: string): _value is ThemeName {
  return true;
}

export async function getColorPalette(theme: ThemeName): Promise<ColorPalette> {
  if (theme === 'light') return getBuiltInPalette('light');
  if (theme === 'dark') return getBuiltInPalette('dark');
  if (theme === 'auto') {
    const detected = await detectTerminalTheme();
    return getBuiltInPalette(detected);
  }
  const custom = await loadCustomThemeMerged(theme);
  return custom ?? getBuiltInPalette('dark');
}

export function getColorPaletteSync(theme: ThemeName): ColorPalette {
  if (theme === 'light') return getBuiltInPalette('light');
  return getBuiltInPalette('dark');
}
