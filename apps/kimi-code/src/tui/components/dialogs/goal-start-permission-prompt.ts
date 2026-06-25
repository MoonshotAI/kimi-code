import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type GoalStartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface GoalStartPermissionPromptOptions {
  readonly mode: 'manual' | 'yolo';
  readonly onSelect: (choice: GoalStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

export const GOAL_START_MANUAL_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically, and questions are skipped.',
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
      'Keep approvals on. Kimi Code will ask before risky actions, so the goal may stop and wait for you.',
  },
  {
    value: 'cancel',
    label: 'Do not start',
    description: 'Return to the input box with your goal command.',
  },
];

export const GOAL_START_YOLO_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically, and questions are skipped.',
  },
  {
    value: 'yolo',
    label: 'Keep YOLO and start',
    description:
      'Tools and plan changes stay approved automatically. Kimi Code may still ask you questions.',
  },
  {
    value: 'cancel',
    label: 'Do not start',
    description: 'Return to the input box with your goal command.',
  },
];

export function goalStartOptions(mode: 'manual' | 'yolo'): readonly StartPermissionOption[] {
  return mode === 'yolo' ? GOAL_START_YOLO_OPTIONS : GOAL_START_MANUAL_OPTIONS;
}

const MANUAL_OPTIONS = GOAL_START_MANUAL_OPTIONS;

const YOLO_OPTIONS = GOAL_START_YOLO_OPTIONS;

const MANUAL_NOTICE_LINES = [
  'Manual mode asks you before Kimi Code runs commands, edits files, or takes other risky actions.',
  'Manual mode is not suitable for unattended goal work.',
  'You can go back without losing your command.',
] as const;

const YOLO_NOTICE_LINES = [
  'YOLO mode approves tools and plan changes automatically.',
  'YOLO mode can still stop for questions.',
  'Switch to Auto if you want questions skipped during goal work.',
] as const;

export class GoalStartPermissionPromptComponent extends StartPermissionPromptComponent {
  constructor(opts: GoalStartPermissionPromptOptions) {
    super({
      title:
        opts.mode === 'yolo'
          ? 'Start a goal in YOLO mode?'
          : 'Start a goal with approvals on?',
      noticeLines: opts.mode === 'yolo' ? YOLO_NOTICE_LINES : MANUAL_NOTICE_LINES,
      options: opts.mode === 'yolo' ? YOLO_OPTIONS : MANUAL_OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
