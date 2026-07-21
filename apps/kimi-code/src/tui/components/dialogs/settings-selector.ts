import { t } from '#/i18n';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export type SettingsSelection =
  | 'model'
  | 'theme'
  | 'editor'
  | 'language'
  | 'permission'
  | 'experiments'
  | 'upgrade'
  | 'usage'
  | 'github_token'
  | 'astron';

function getSettingsOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'model',
      label: t('tui.dialogs.settingsSelector.model'),
      description: t('tui.dialogs.settingsSelector.modelDesc'),
    },
    {
      value: 'permission',
      label: t('tui.dialogs.settingsSelector.permission'),
      description: t('tui.dialogs.settingsSelector.permissionDesc'),
    },
    {
      value: 'theme',
      label: t('tui.dialogs.settingsSelector.theme'),
      description: t('tui.dialogs.settingsSelector.themeDesc'),
    },
    {
      value: 'language',
      label: t('tui.dialogs.settingsSelector.language'),
      description: t('tui.dialogs.settingsSelector.languageDesc'),
    },
    {
      value: 'editor',
      label: t('tui.dialogs.settingsSelector.editor'),
      description: t('tui.dialogs.settingsSelector.editorDesc'),
    },
    {
      value: 'experiments',
      label: t('tui.dialogs.settingsSelector.experiments'),
      description: t('tui.dialogs.settingsSelector.experimentsDesc'),
    },
    {
      value: 'upgrade',
      label: t('tui.dialogs.settingsSelector.upgrade'),
      description: t('tui.dialogs.settingsSelector.upgradeDesc'),
    },
    {
      value: 'usage',
      label: t('tui.dialogs.settingsSelector.usage'),
      description: t('tui.dialogs.settingsSelector.usageDesc'),
    },
    {
      value: 'github_token',
      label: t('tui.dialogs.settingsSelector.githubToken'),
      description: t('tui.dialogs.settingsSelector.githubTokenDesc'),
    },
    {
      value: 'astron',
      label: t('tui.dialogs.settingsSelector.astron'),
      description: t('tui.dialogs.settingsSelector.astronDesc'),
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
    value === 'usage' ||
    value === 'github_token' ||
    value === 'astron'
  );
}

export interface SettingsSelectorOptions {
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    super({
      title: t('tui.dialogs.settingsSelector.title'),
      options: [...getSettingsOptions()],
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}