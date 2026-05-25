import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  fuzzyFilter,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import type { ColorPalette } from '#/tui/theme/colors';
import { pageView } from '#/tui/utils/paging';
import { isPrintableChar, printableChar } from '#/tui/utils/printable-key';

import type { ChoiceOption } from './choice-picker';

const DEFAULT_PAGE_SIZE = 8;

type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  readonly label: string;
}

export interface ModelSelection {
  readonly alias: string;
  readonly thinking: boolean;
}

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  return model?.displayName ?? model?.model ?? alias;
}

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}

export function createModelChoiceOptions(
  models: Record<string, ModelAlias>,
): readonly ChoiceOption[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    value: alias,
    label: `${modelDisplayName(alias, cfg)} (${providerDisplayName(cfg.provider)})`,
  }));
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

function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    alias,
    model: cfg,
    label: `${modelDisplayName(alias, cfg)} (${providerDisplayName(cfg.provider)})`,
  }));
}

function thinkingAvailability(model: ModelAlias): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  if (caps.includes('thinking')) return 'toggle';
  return 'unsupported';
}

function effectiveThinking(model: ModelAlias, thinkingDraft: boolean): boolean {
  const availability = thinkingAvailability(model);
  if (availability === 'always-on') return true;
  if (availability === 'unsupported') return false;
  return thinkingDraft;
}

export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly choices: readonly ModelChoice[];
  private selectedIndex: number;
  private thinkingDraft: boolean;
  private query = '';

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    this.choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = this.choices.findIndex((choice) => choice.alias === selectedValue);
    this.selectedIndex = Math.max(selectedIdx, 0);
    this.thinkingDraft = opts.currentThinking;
  }

  private get pageSize(): number {
    return this.opts.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  private filteredChoices(): readonly ModelChoice[] {
    if (this.query.length === 0) return this.choices;
    return fuzzyFilter([...this.choices], this.query, (c) => c.label);
  }

  handleInput(data: string): void {
    const choices = this.filteredChoices();
    const lastIndex = Math.max(0, choices.length - 1);
    const searchable = this.opts.searchable === true;
    const selected = choices[this.selectedIndex];

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
    if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(lastIndex, this.selectedIndex + this.pageSize);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.pageSize);
      return;
    }
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
    const choices = this.filteredChoices();
    const view = pageView(choices.length, this.selectedIndex, this.pageSize);
    const selectedIndex = Math.min(this.selectedIndex, Math.max(0, choices.length - 1));

    const navParts = ['↑↓ model', '←→ thinking'];
    if (view.pageCount > 1) navParts.push('PgUp/PgDn page');
    navParts.push('Enter apply', 'Esc cancel');

    const titleSuffix =
      searchable && this.query.length === 0 ? chalk.hex(colors.textMuted)('  (type to search)') : '';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Select a model') + titleSuffix,
    ];
    if (searchable && this.query.length > 0) {
      lines.push(chalk.hex(colors.primary)(' Search: ') + chalk.hex(colors.text)(this.query));
    }
    lines.push(chalk.hex(colors.textMuted)(` ${navParts.join(' · ')}`));
    lines.push('');

    if (choices.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('   No matches'));
    }
    for (let i = view.start; i < view.end; i++) {
      const choice = choices[i]!;
      const isSelected = i === selectedIndex;
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
    const selected = choices[selectedIndex];
    if (selected !== undefined) {
      lines.push(this.renderThinkingControl(selected.model));
    }
    lines.push('');
    if (view.pageCount > 1) {
      lines.push(
        chalk.hex(colors.textMuted)(` Page ${String(view.page + 1)}/${String(view.pageCount)}`),
      );
    }
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderThinkingControl(model: ModelAlias): string {
    const { colors } = this.opts;
    const segment = (label: string, active: boolean): string =>
      active
        ? chalk.hex(colors.primary).bold(`[ ${label} ]`)
        : chalk.hex(colors.text)(`  ${label}  `);

    const availability = thinkingAvailability(model);
    if (availability === 'always-on') {
      return `  ${segment('Always on', true)}`;
    }
    if (availability === 'unsupported') {
      return `  ${segment('Off', true)} ${chalk.hex(colors.textMuted)('unsupported')}`;
    }
    return `  ${segment('On', this.thinkingDraft)}  ${segment('Off', !this.thinkingDraft)}`;
  }
}
