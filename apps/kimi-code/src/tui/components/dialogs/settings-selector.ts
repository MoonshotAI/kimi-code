import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import { t } from '#/tui/i18n';

export type SettingsSelection =
  | 'model'
  | 'theme'
  | 'language'
  | 'editor'
  | 'permission'
  | 'experiments'
  | 'upgrade'
  | 'usage';

function settingsOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'model',
      label: t('settings.model'),
      description: t('settings.modelDescription'),
    },
    {
      value: 'permission',
      label: t('settings.permission'),
      description: t('settings.permissionDescription'),
    },
    {
      value: 'theme',
      label: t('settings.theme'),
      description: t('settings.themeDescription'),
    },
    {
      value: 'language',
      label: t('settings.language'),
      description: t('settings.languageDescription'),
    },
    {
      value: 'editor',
      label: t('settings.editor'),
      description: t('settings.editorDescription'),
    },
    {
      value: 'experiments',
      label: t('settings.experiments'),
      description: t('settings.experimentsDescription'),
    },
    {
      value: 'upgrade',
      label: t('settings.upgrade'),
      description: t('settings.upgradeDescription'),
    },
    {
      value: 'usage',
      label: t('settings.usage'),
      description: t('settings.usageDescription'),
    },
  ];
}

function isSettingsSelection(value: string): value is SettingsSelection {
  return (
    value === 'model' ||
    value === 'theme' ||
    value === 'language' ||
    value === 'editor' ||
    value === 'permission' ||
    value === 'experiments' ||
    value === 'upgrade' ||
    value === 'usage'
  );
}

export interface SettingsSelectorOptions {
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    super({
      title: t('settings.title'),
      options: [...settingsOptions()],
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
