import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function getPermissionOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'manual',
      label: t('tui.dialogs.permissionSelector.manual'),
      description: t('tui.dialogs.permissionSelector.manualDesc'),
    },
    {
      value: 'auto',
      label: t('tui.dialogs.permissionSelector.auto'),
      description: t('tui.dialogs.permissionSelector.autoDesc'),
    },
    {
      value: 'yolo',
      label: t('tui.dialogs.permissionSelector.yolo'),
      description: t('tui.dialogs.permissionSelector.yoloDesc'),
    },
  ];
}

function isPermissionModeChoice(value: string): value is PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'yolo';
}

export interface PermissionSelectorOptions {
  readonly currentValue: PermissionMode;
  readonly onSelect: (mode: PermissionMode) => void;
  readonly onCancel: () => void;
}

export class PermissionSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PermissionSelectorOptions) {
    super({
      title: t('tui.dialogs.permissionSelector.title'),
      options: [...getPermissionOptions()],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        if (isPermissionModeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}