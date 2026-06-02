/**
 * Color palette definitions for dark and light themes.
 *
 * Two layers:
 *  - private `dark` / `light` raw palettes — unsemantic constants reused
 *    across multiple semantic tokens to avoid hex literal duplication.
 *  - exported `darkColors` / `lightColors` — the semantic `ColorPalette`
 *    consumed by every UI component via chalk.hex(...).
 *
 * Light palette values are tuned for ≥ 4.5:1 contrast against #FFFFFF
 * for text tokens and ≥ 3:1 for chrome (border / large text), matching
 * WCAG AA.
 */

const dark = {
  blue400: '#4FA8FF',
  cyan400: '#5BC0BE',
  gray50: '#F5F5F5',
  gray100: '#E0E0E0',
  gray500: '#888888',
  gray600: '#6B6B6B',
  gray700: '#5A5A5A',
  green400: '#4EC87E',
  green300: '#7AD99B',
  red400: '#E85454',
  red300: '#F08585',
  red700: '#B91C1C',
  amber400: '#E8A838',
  orange300: '#FFCB6B',
} as const;

const light = {
  blue600: '#1565C0',
  cyan700: '#00838F',
  gray900: '#1A1A1A',
  gray700: '#454545',
  gray600: '#5F5F5F',
  gray500: '#737373',
  green700: '#0E7A38',
  red700: '#B91C1C',
  amber800: '#92660A',
  orange700: '#9A4A00',
} as const;

export interface ColorPalette {
  // Brand
  primary: string;
  accent: string;

  // Text
  text: string;
  textStrong: string;
  textDim: string;
  textMuted: string;

  // Surface
  border: string;
  borderFocus: string;

  // State
  success: string;
  warning: string;
  error: string;

  // Diff
  diffAdded: string;
  diffRemoved: string;
  diffAddedStrong: string;
  diffRemovedStrong: string;
  diffGutter: string;
  diffMeta: string;

  // Roles
  roleUser: string;
  roleAssistant: string;
  roleThinking: string;
  roleTool: string;

  // Status
  status: string;

  // Undo preview
  undoHighlight: string;
}

export const darkColors: ColorPalette = {
  primary: dark.blue400,
  accent: dark.cyan400,

  text: dark.gray100,
  textStrong: dark.gray50,
  textDim: dark.gray500,
  textMuted: dark.gray600,

  border: dark.gray700,
  borderFocus: dark.amber400,

  success: dark.green400,
  warning: dark.amber400,
  error: dark.red400,

  diffAdded: dark.green400,
  diffRemoved: dark.red400,
  diffAddedStrong: dark.green300,
  diffRemovedStrong: dark.red300,
  diffGutter: dark.gray600,
  diffMeta: dark.gray500,

  roleUser: dark.orange300,
  roleAssistant: dark.gray100,
  roleThinking: dark.gray500,
  roleTool: dark.amber400,

  status: dark.gray500,
  undoHighlight: dark.red700,
};

export const lightColors: ColorPalette = {
  primary: light.blue600,
  accent: light.cyan700,

  text: light.gray900,
  textStrong: light.gray900,
  textDim: light.gray700,
  textMuted: light.gray600,

  border: light.gray500,
  borderFocus: light.amber800,

  success: light.green700,
  warning: light.amber800,
  error: light.red700,

  diffAdded: light.green700,
  diffRemoved: light.red700,
  diffAddedStrong: light.green700,
  diffRemovedStrong: light.red700,
  diffGutter: light.gray500,
  diffMeta: light.gray600,

  roleUser: light.orange700,
  roleAssistant: light.gray900,
  roleThinking: light.gray700,
  roleTool: light.amber800,

  status: light.gray700,
  undoHighlight: light.red700,
};

export type ResolvedTheme = 'dark' | 'light';

export function getColorPalette(theme: ResolvedTheme): ColorPalette {
  return theme === 'dark' ? darkColors : lightColors;
}
