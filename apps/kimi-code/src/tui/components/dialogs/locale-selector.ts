import type { Locale } from '#/i18n';
import { t } from '#/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function getLocaleOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'en',
      label: t('tui.dialogs.localeSelector.enLabel'),
      description: t('tui.dialogs.localeSelector.enDesc'),
    },
    {
      value: 'zh',
      label: t('tui.dialogs.localeSelector.zhLabel'),
      description: t('tui.dialogs.localeSelector.zhDesc'),
    },
  ];
}

function isLocaleChoice(value: string): value is Locale {
  return value === 'en' || value === 'zh';
}

export interface LocaleSelectorOptions {
  readonly currentValue: Locale;
  readonly onSelect: (locale: Locale) => void;
  readonly onCancel: () => void;
}

export class LocaleSelectorComponent extends ChoicePickerComponent {
  constructor(opts: LocaleSelectorOptions) {
    super({
      title: t('tui.dialogs.localeSelector.title'),
      options: [...getLocaleOptions()],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        if (isLocaleChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}