import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { SearchableList } from '#/tui/utils/searchable-list';

import {
  createModelChoices,
  effectiveThinking,
  renderThinkingControl,
  thinkingAvailability,
  type ModelChoice,
} from './model-choice';

export interface ModelSelection {
  readonly alias: string;
  readonly thinking: boolean;
}

export interface ModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinking: boolean;
  readonly colors: ColorPalette;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate (PgUp/PgDn). */
  readonly pageSize?: number;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  private thinkingDraft: boolean;

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.alias === selectedValue);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (c) => c.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
    this.thinkingDraft = opts.currentThinking;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    const selected = this.list.selected();
    // Left/Right toggle thinking (only when the model supports it); paging is on
    // PgUp/PgDn so the horizontal arrows stay free for the thinking control.
    if (selected !== undefined && thinkingAvailability(selected.model) === 'toggle') {
      if (matchesKey(data, Key.left)) {
        this.thinkingDraft = true;
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.thinkingDraft = false;
        return;
      }
    }
    if (matchesKey(data, Key.enter)) {
      if (selected === undefined) return;
      this.opts.onSelect({
        alias: selected.alias,
        thinking: effectiveThinking(selected.model, this.thinkingDraft),
      });
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const { colors } = this.opts;
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const choices = view.items;

    const navParts = ['↑↓ model', '←→ thinking'];
    if (view.page.pageCount > 1) navParts.push('PgUp/PgDn page');
    navParts.push('Enter apply', 'Esc cancel');

    const titleSuffix =
      searchable && view.query.length === 0 ? chalk.hex(colors.textMuted)('  (type to search)') : '';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Select a model') + titleSuffix,
    ];
    if (searchable && view.query.length > 0) {
      lines.push(chalk.hex(colors.primary)(' Search: ') + chalk.hex(colors.text)(view.query));
    }
    lines.push(chalk.hex(colors.textMuted)(` ${navParts.join(' · ')}`));
    lines.push('');

    if (choices.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('   No matches'));
    }
    for (let i = view.page.start; i < view.page.end; i++) {
      const choice = choices[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = choice.alias === this.opts.currentValue;
      const pointer = isSelected ? '❯' : ' ';
      const labelStyle = isSelected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
      let line = chalk.hex(isSelected ? colors.primary : colors.textDim)(`  ${pointer} `);
      line += labelStyle(choice.label);
      if (isCurrent) {
        line += ' ' + chalk.hex(colors.success)('← current');
      }
      lines.push(line);
    }

    lines.push('');
    lines.push(chalk.hex(colors.textMuted)(' Thinking'));
    const selected = choices[view.selectedIndex];
    if (selected !== undefined) {
      lines.push(renderThinkingControl(selected.model, this.thinkingDraft, colors));
    }
    lines.push('');
    if (view.page.pageCount > 1) {
      lines.push(
        chalk.hex(colors.textMuted)(
          ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
        ),
      );
    }
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
