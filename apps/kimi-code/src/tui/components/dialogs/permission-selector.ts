import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { PERMISSION_MODE_DISPLAY_NAMES } from '#/tui/utils/permission-mode';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const PERMISSION_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'manual',
    label: PERMISSION_MODE_DISPLAY_NAMES.manual,
    description: 'Auto-read only; everything else needs your approval first.',
  },
  {
    value: 'yolo',
    label: PERMISSION_MODE_DISPLAY_NAMES.yolo,
    description:
      'Routine edits and commands run automatically; risky actions, questions, and plans still ask.',
  },
  {
    value: 'auto',
    label: PERMISSION_MODE_DISPLAY_NAMES.auto,
    description: 'Never interrupts you; everything runs and is decided automatically.',
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
