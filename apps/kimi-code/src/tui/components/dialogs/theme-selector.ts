import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import { t } from '#/tui/i18n';
import { listCustomThemesSync } from '#/tui/theme/custom-theme-loader';
import type { ThemeName } from '#/tui/theme/index';

function themeOptions(): readonly ChoiceOption[] {
  return [
    { value: 'auto', label: t('theme.auto') },
    { value: 'dark', label: t('theme.dark') },
    { value: 'light', label: t('theme.light') },
  ];
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
      ...themeOptions(),
      ...customThemes.map((name) => ({ value: name, label: t('theme.custom', { name }) })),
    ];
    super({
      title: t('theme.title'),
      options,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
