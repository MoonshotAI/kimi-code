import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import { listCustomThemesSync } from '#/tui/theme/custom-theme-loader';
import type { ThemeName } from '#/tui/theme/index';

const THEME_OPTIONS: readonly ChoiceOption[] = [
  { value: 'auto', label: 'Auto (match terminal)' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

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
