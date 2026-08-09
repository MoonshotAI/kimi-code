import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const PERMISSION_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'manual',
    label: 'Manual',
    description: 'Approve every action yourself.',
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Auto-approve tool actions, but the agent may still ask questions.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Fully autonomous — agent decides everything without asking.',
  },
];

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
      title: 'Select permission mode',
      options: [...PERMISSION_OPTIONS],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        if (isPermissionModeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
