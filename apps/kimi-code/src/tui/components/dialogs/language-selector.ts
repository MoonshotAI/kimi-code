import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { Language } from '#/tui/i18n';
import { t } from '#/tui/i18n';

function languageOptions(): readonly ChoiceOption[] {
  return [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ];
}

export interface LanguageSelectorOptions {
  readonly currentValue: Language;
  readonly onSelect: (language: Language) => void;
  readonly onCancel: () => void;
}

export class LanguageSelectorComponent extends ChoicePickerComponent {
  constructor(opts: LanguageSelectorOptions) {
    super({
      title: t('language.label'),
      options: [...languageOptions()],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value as Language);
      },
      onCancel: opts.onCancel,
    });
  }
}
