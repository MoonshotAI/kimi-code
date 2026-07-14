import { t } from '#/i18n';
import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type SwarmStartPermissionChoice = 'auto' | 'yolo' | 'manual';

export interface SwarmStartPermissionPromptOptions {
  readonly onSelect: (choice: SwarmStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

function swarmOptions(): readonly StartPermissionOption<SwarmStartPermissionChoice>[] {
  return [
    {
      value: 'auto',
      label: t('tui.dialogs.swarmStartPermissionPrompt.optionAutoLabel'),
      description: t('tui.dialogs.swarmStartPermissionPrompt.optionAutoDesc'),
    },
    {
      value: 'yolo',
      label: t('tui.dialogs.swarmStartPermissionPrompt.optionYoloLabel'),
      description: t('tui.dialogs.swarmStartPermissionPrompt.optionYoloDesc'),
    },
    {
      value: 'manual',
      label: t('tui.dialogs.swarmStartPermissionPrompt.optionManualLabel'),
      description: t('tui.dialogs.swarmStartPermissionPrompt.optionManualDesc'),
    },
  ];
}

const NOTICE_LINES = [
  t('tui.dialogs.swarmStartPermissionPrompt.notice1'),
  t('tui.dialogs.swarmStartPermissionPrompt.notice2'),
  t('tui.dialogs.swarmStartPermissionPrompt.notice3'),
] as const;

export class SwarmStartPermissionPromptComponent extends StartPermissionPromptComponent<SwarmStartPermissionChoice> {
  constructor(opts: SwarmStartPermissionPromptOptions) {
    super({
      title: t('tui.dialogs.swarmStartPermissionPrompt.title'),
      noticeLines: NOTICE_LINES,
      options: swarmOptions(),
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
