import type { ColorPalette } from '#/tui/theme/colors';

import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type SwarmStartPermissionChoice = 'auto' | 'manual';

export interface SwarmStartPermissionPromptOptions {
  readonly colors: ColorPalette;
  readonly onSelect: (choice: SwarmStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

const OPTIONS: readonly StartPermissionOption<SwarmStartPermissionChoice>[] = [
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Best for swarm tasks. Tools are approved automatically, and questions are skipped.',
  },
  {
    value: 'manual',
    label: 'Start in Manual',
    description:
      'Keep approvals on. Kimi Code may stop and wait for you during the swarm task.',
  },
];

const NOTICE_LINES = [
  'Manual mode asks you before Kimi Code runs commands, edits files, or takes other risky actions.',
  'Manual mode can block swarm work while agents are running.',
  'You can go back without losing your command.',
] as const;

export class SwarmStartPermissionPromptComponent extends StartPermissionPromptComponent<SwarmStartPermissionChoice> {
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
