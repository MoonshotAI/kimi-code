import type { ColorPalette } from '#/tui/theme/colors';

import {
  StartPermissionPromptComponent,
  type StartPermissionChoice,
  type StartPermissionOption,
} from './start-permission-prompt';

export type SwarmStartPermissionChoice = StartPermissionChoice;

export interface SwarmStartPermissionPromptOptions {
  readonly colors: ColorPalette;
  readonly onSelect: (choice: SwarmStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

const OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Best for swarm tasks. Tools are approved automatically, and questions are skipped.',
  },
  {
    value: 'yolo',
    label: 'Switch to YOLO and start',
    description:
      'Tools and plan changes are approved automatically. Kimi Code may still ask you questions.',
  },
  {
    value: 'manual',
    label: 'Start in Manual',
    description:
      'Keep approvals on. Kimi Code may stop and wait for you during the swarm task.',
  },
  {
    value: 'cancel',
    label: 'Do not start',
    description: 'Return to the input box with your swarm command.',
  },
];

const NOTICE_LINES = [
  'Manual mode asks you before Kimi Code runs commands, edits files, or takes other risky actions.',
  'Manual mode can block swarm work while agents are running.',
  'You can go back without losing your command.',
] as const;

export class SwarmStartPermissionPromptComponent extends StartPermissionPromptComponent {
  constructor(opts: SwarmStartPermissionPromptOptions) {
    super({
      colors: opts.colors,
      title: 'Start a swarm task with approvals on?',
      noticeLines: NOTICE_LINES,
      options: OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
