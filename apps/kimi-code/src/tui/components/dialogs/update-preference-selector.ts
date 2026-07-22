import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { t } from '#/i18n';

function getUpdatePreferenceOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'on',
      label: t('tui.dialogs.updatePreferenceSelector.on'),
      description: t('tui.dialogs.updatePreferenceSelector.onDescription'),
    },
    {
      value: 'off',
      label: t('tui.dialogs.updatePreferenceSelector.off'),
      description: t('tui.dialogs.updatePreferenceSelector.offDescription'),
    },
  ];
}

export interface UpdatePreferenceSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class UpdatePreferenceSelectorComponent extends ChoicePickerComponent {
  constructor(opts: UpdatePreferenceSelectorOptions) {
    super({
      title: t('tui.dialogs.updatePreferenceSelector.title'),
      options: [...getUpdatePreferenceOptions()],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
