import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { BuiltInTheme, ThemeName } from '#/tui/theme/index';
import { isBuiltInTheme, listCustomThemes } from '#/tui/theme';

const THEME_OPTIONS: readonly ChoiceOption[] = [
  { value: 'auto', label: 'Auto (match terminal)' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

function isThemeChoice(value: string): value is BuiltInTheme {
  return isBuiltInTheme(value);
}

export interface ThemeSelectorOptions {
  readonly currentValue: ThemeName;
  readonly onSelect: (theme: ThemeName) => void;
  readonly onCancel: () => void;
}

export class ThemeSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ThemeSelectorOptions) {
    const customThemes = listCustomThemesSync();
    const options: ChoiceOption[] = [
      ...THEME_OPTIONS,
      ...customThemes.map((name) => ({ value: name, label: `Custom: ${name}` })),
    ];
    super({
      title: 'Select theme',
      options,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}

// Synchronous fallback — reads dir synchronously for the picker.
import { readdirSync } from 'node:fs';
import { getCustomThemesDir } from '#/tui/theme/custom-theme-loader';

function listCustomThemesSync(): string[] {
  try {
    const entries = readdirSync(getCustomThemesDir(), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
