import { describe, expect, it } from 'vitest';

import { darkColors, lightColors, getColorPalette } from '#/tui/theme/colors';
import { createThemeStyles } from '#/tui/theme/styles';

describe('ColorPalette warning token', () => {
  it('has a defined warning color in both themes', () => {
    expect(darkColors.warning).toBeTruthy();
    expect(lightColors.warning).toBeTruthy();
    expect(darkColors.warning).not.toBe(lightColors.warning);
  });

  it('resolves the correct palette by theme name', () => {
    expect(getColorPalette('dark')).toBe(darkColors);
    expect(getColorPalette('light')).toBe(lightColors);
  });
});

describe('ThemeStyles warning helper', () => {
  it('wraps text and includes the input', () => {
    const styles = createThemeStyles(darkColors);
    const result = styles.warning('test');
    expect(result).toContain('test');
  });

  it('is a function that returns a string', () => {
    const darkStyles = createThemeStyles(darkColors);
    expect(typeof darkStyles.warning).toBe('function');
    expect(typeof darkStyles.warning('hello')).toBe('string');
  });

  it('creates independent style sets per palette', () => {
    const darkStyles = createThemeStyles(darkColors);
    const lightStyles = createThemeStyles(lightColors);
    expect(darkStyles.colors.warning).toBe(darkColors.warning);
    expect(lightStyles.colors.warning).toBe(lightColors.warning);
    expect(darkStyles.colors.warning).not.toBe(lightStyles.colors.warning);
  });
});
