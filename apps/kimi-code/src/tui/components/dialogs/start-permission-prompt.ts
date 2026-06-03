import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export type StartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface StartPermissionOption {
  readonly value: StartPermissionChoice;
  readonly label: string;
  readonly description: string;
}

export interface StartPermissionPromptOptions {
  readonly colors: ColorPalette;
  readonly title: string;
  readonly noticeLines: readonly string[];
  readonly options: readonly StartPermissionOption[];
  readonly onSelect: (choice: StartPermissionChoice) => void;
  readonly onCancel: () => void;
}

export class StartPermissionPromptComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;

  constructor(private readonly opts: StartPermissionPromptOptions) {}

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
      this.selectedIndex = Math.min(this.opts.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(this.opts.options[this.selectedIndex]!.value);
    }
  }

  render(width: number): string[] {
    const { colors } = this.opts;
    const rule = chalk.hex(colors.primary)('─'.repeat(width));
    const lines = [
      rule,
      chalk.hex(colors.primary).bold(` ${this.opts.title}`),
      chalk.hex(colors.textMuted)(' ↑↓ navigate · Enter select · Esc return to input box'),
      '',
    ];

    const textWidth = Math.max(20, width - 2);
    for (const paragraph of this.opts.noticeLines) {
      for (const line of wrapPlain(paragraph, textWidth)) {
        lines.push(` ${styleModeNames(line, colors, colors.textMuted)}`);
      }
      lines.push('');
    }

    for (let i = 0; i < this.opts.options.length; i += 1) {
      const option = this.opts.options[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? '❯' : ' ';
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
