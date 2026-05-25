/**
 * ChoicePicker — modal single-select list for slash commands that ask
 * the user to pick from a small set of preset values.
 *
 * Mirrors SessionPickerComponent's container-replacement pattern: host
 * calls `showChoicePicker(...)` which clears the editor container,
 * addChild(picker), setFocus(picker); the picker invokes `onSelect` or
 * `onCancel`, and the host tears it down.
 */

import {
  Container,
  fuzzyFilter,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { pageView } from '#/tui/utils/paging';
import { isPrintableChar, printableChar } from '#/tui/utils/printable-key';

export interface ChoiceOption {
  /** Value passed to onSelect (e.g. the actual editor command string). */
  readonly value: string;
  /** Display text shown in the list. */
  readonly label: string;
  /** Optional explanatory text shown below the label. */
  readonly description?: string | undefined;
}

export interface ChoicePickerOptions {
  readonly title: string;
  readonly hint?: string;
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  readonly colors: ColorPalette;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate. */
  readonly pageSize?: number;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

const CURRENT_MARK = '← current';
const DEFAULT_PAGE_SIZE = 8;

function wrapDescription(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, '…');
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

export class ChoicePickerComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ChoicePickerOptions;
  private selectedIndex: number;
  private query = '';

  constructor(opts: ChoicePickerOptions) {
    super();
    this.opts = opts;
    const currentIdx = opts.options.findIndex((o) => o.value === opts.currentValue);
    this.selectedIndex = Math.max(currentIdx, 0);
  }

  private get pageSize(): number {
    return this.opts.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  private filteredOptions(): readonly ChoiceOption[] {
    if (this.query.length === 0) return this.opts.options;
    return fuzzyFilter(
      [...this.opts.options],
      this.query,
      (o) => `${o.label} ${o.description ?? ''}`,
    );
  }

  handleInput(data: string): void {
    const options = this.filteredOptions();
    const lastIndex = Math.max(0, options.length - 1);
    const searchable = this.opts.searchable === true;

    if (matchesKey(data, Key.escape)) {
      if (searchable && this.query.length > 0) {
        this.query = '';
        this.selectedIndex = 0;
        return;
      }
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(lastIndex, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.right)) {
      this.selectedIndex = Math.min(lastIndex, this.selectedIndex + this.pageSize);
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.left)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.pageSize);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = options[this.selectedIndex];
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
    if (!searchable) return;
    if (matchesKey(data, Key.backspace)) {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
      }
      return;
    }
    const ch = printableChar(data);
    if (isPrintableChar(ch)) {
      this.query += ch;
      this.selectedIndex = 0;
    }
  }

  override render(width: number): string[] {
    const { colors } = this.opts;
    const searchable = this.opts.searchable === true;
    const options = this.filteredOptions();
    const view = pageView(options.length, this.selectedIndex, this.pageSize);
    const selectedIndex = Math.min(this.selectedIndex, Math.max(0, options.length - 1));

    const navParts = ['↑↓ navigate'];
    if (view.pageCount > 1) navParts.push('←→ page');
    navParts.push('Enter select', 'Esc cancel');
    const hint = this.opts.hint ?? navParts.join(' · ');

    const titleSuffix =
      searchable && this.query.length === 0 ? chalk.hex(colors.textMuted)('  (type to search)') : '';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(` ${this.opts.title}`) + titleSuffix,
    ];
    if (searchable && this.query.length > 0) {
      lines.push(chalk.hex(colors.primary)(` Search: `) + chalk.hex(colors.text)(this.query));
    }
    lines.push(chalk.hex(colors.textMuted)(` ${hint}`));
    lines.push('');

    if (options.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('   No matches'));
    }
    for (let i = view.start; i < view.end; i++) {
      const opt = options[i]!;
      const isSelected = i === selectedIndex;
      const isCurrent = opt.value === this.opts.currentValue;
      const pointer = isSelected ? '❯' : ' ';
      const labelStyle = isSelected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
      let line = chalk.hex(isSelected ? colors.primary : colors.textDim)(`  ${pointer} `);
      line += labelStyle(opt.label);
      if (isCurrent) {
        line += ' ' + chalk.hex(colors.success)(CURRENT_MARK);
      }
      lines.push(line);
      if (opt.description !== undefined && opt.description.length > 0) {
        const descriptionWidth = Math.max(1, width - 4);
        for (const descLine of wrapDescription(opt.description, descriptionWidth)) {
          lines.push(chalk.hex(colors.textMuted)(`    ${descLine}`));
        }
      }
    }

    lines.push('');
    if (view.pageCount > 1) {
      lines.push(
        chalk.hex(colors.textMuted)(
          ` Page ${String(view.page + 1)}/${String(view.pageCount)}`,
        ),
      );
    }
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
