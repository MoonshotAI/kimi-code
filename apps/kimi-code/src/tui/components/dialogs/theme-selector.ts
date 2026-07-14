import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import { listCustomThemesSync } from '#/tui/theme/custom-theme-loader';
import type { ThemeName } from '#/tui/theme/index';
import { t } from '#/i18n';

function getThemeOptions(): readonly ChoiceOption[] {
  return [
    { value: 'auto', label: t('tui.dialogs.themeSelector.auto') },
    { value: 'dark', label: t('tui.dialogs.themeSelector.dark') },
    { value: 'light', label: t('tui.dialogs.themeSelector.light') },
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
      ...getThemeOptions(),
      ...customThemes.map((name) => ({ value: name, label: t('tui.dialogs.themeSelector.custom', { name }) })),
    ];
    super({
      title: t('tui.dialogs.themeSelector.title'),
      options,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}