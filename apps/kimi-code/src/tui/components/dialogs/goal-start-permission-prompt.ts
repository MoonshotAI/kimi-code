import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

export type GoalStartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

interface GoalStartOption {
  readonly value: GoalStartPermissionChoice;
  readonly label: string;
  readonly description: string;
}

export interface GoalStartPermissionPromptOptions {
  readonly colors: ColorPalette;
  readonly mode: 'manual' | 'yolo';
  readonly onSelect: (choice: GoalStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

const MANUAL_OPTIONS: readonly GoalStartOption[] = [
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

const YOLO_OPTIONS: readonly GoalStartOption[] = [
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

export class GoalStartPermissionPromptComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;

  constructor(private readonly opts: GoalStartPermissionPromptOptions) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(this.options[this.selectedIndex]!.value);
    }
  }

  render(width: number): string[] {
    const { colors } = this.opts;
    const rule = chalk.hex(colors.primary)('─'.repeat(width));
    const lines = [
      rule,
      chalk.hex(colors.primary).bold(` ${this.title}`),
      chalk.hex(colors.textMuted)(' ↑↓ navigate · Enter select · Esc cancel'),
      '',
    ];

    const textWidth = Math.max(20, width - 2);
    for (const paragraph of this.noticeLines) {
      for (const line of wrapPlain(paragraph, textWidth)) {
        lines.push(` ${styleModeNames(line, colors, colors.textMuted)}`);
      }
      lines.push('');
    }

    for (let i = 0; i < this.options.length; i += 1) {
      const option = this.options[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      lines.push(
        chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `) +
          styleLabel(option.label, selected, colors),
      );
      for (const line of wrapPlain(option.description, Math.max(20, width - 4))) {
        lines.push(`    ${styleModeNames(line, colors, colors.textMuted)}`);
      }
      lines.push('');
    }

    lines.push(rule);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private get options(): readonly GoalStartOption[] {
    return this.opts.mode === 'yolo' ? YOLO_OPTIONS : MANUAL_OPTIONS;
  }

  private get noticeLines(): readonly string[] {
    return this.opts.mode === 'yolo' ? YOLO_NOTICE_LINES : MANUAL_NOTICE_LINES;
  }

  private get title(): string {
    return this.opts.mode === 'yolo'
      ? 'Start a goal in YOLO mode?'
      : 'Start a goal with approvals on?';
  }
}

function styleLabel(label: string, selected: boolean, colors: ColorPalette): string {
  if (selected) return chalk.hex(colors.primary).bold(label);
  return styleModeNames(label, colors, colors.text);
}

function styleModeNames(text: string, colors: ColorPalette, baseHex: string): string {
  const base = chalk.hex(baseHex);
  const strong = chalk.hex(colors.textStrong).bold;
  return text
    .split(/(\b(?:Manual|Auto|YOLO)\b)/g)
    .map((part) => {
      if (part === 'Manual' || part === 'Auto' || part === 'YOLO') return strong(part);
      return base(part);
    })
    .join('');
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= width ? word : truncateToWidth(word, width, '…');
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
