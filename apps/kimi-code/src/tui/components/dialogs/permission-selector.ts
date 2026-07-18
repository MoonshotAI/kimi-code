import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const PERMISSION_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'manual',
    label: 'Manual',
    description: 'Review actions that require approval.',
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description:
      'Auto-approve regular tools; sensitive actions may still need approval, and the agent may ask.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Run unattended — auto-approve permission prompts and never ask questions.',
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
