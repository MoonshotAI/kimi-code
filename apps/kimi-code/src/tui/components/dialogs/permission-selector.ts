import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const PERMISSION_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'manual',
    label: 'Manual',
    description:
      'Ask before commands, edits, and other risky actions. Read/search tools run directly; session approval rules are respected.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description:
      'Run fully non-interactively. Tool actions are approved automatically, and agent questions are skipped so it can decide on its own.',
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description:
      'Automatically approve tool actions and plan transitions. The agent can still ask you explicit questions when your input is needed.',
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
