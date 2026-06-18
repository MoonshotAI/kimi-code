import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { TuiLanguage } from '#/tui/config';

// Language endonyms ("English", "简体中文") stay in their own script regardless of
// the active UI locale, so users always recognise their own language.
const LANGUAGE_OPTIONS: readonly ChoiceOption[] = [
  { value: 'auto', label: 'Auto (follow system)' },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
];

export interface LanguageSelectorOptions {
  readonly currentValue: TuiLanguage;
  readonly onSelect: (language: TuiLanguage) => void;
  readonly onCancel: () => void;
}

export class LanguageSelectorComponent extends ChoicePickerComponent {
  constructor(opts: LanguageSelectorOptions) {
    super({
      title: 'Language / 界面语言',
      options: [...LANGUAGE_OPTIONS],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value as TuiLanguage);
      },
      onCancel: opts.onCancel,
    });
  }
}
