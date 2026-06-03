import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import { SearchableList } from '#/tui/utils/searchable-list';

import type { ChoiceOption } from './choice-picker';

type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  /** Model display name (left column). */
  readonly name: string;
  /** Provider display name (right column). */
  readonly provider: string;
  /** Combined text the fuzzy filter matches against (name + provider). */
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
  /** When true, the hint line mentions the Tab provider switch — set by
   * TabbedModelSelectorComponent so the inner list advertises the tab keys. */
  readonly providerSwitchHint?: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const name = modelDisplayName(alias, cfg);
    const provider = providerDisplayName(cfg.provider);
    return { alias, model: cfg, name, provider, label: `${name} (${provider})` };
  });
}

function thinkingAvailability(model: ModelAlias): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  if (caps.includes('thinking') || model.adaptiveThinking === true) return 'toggle';
  return 'unsupported';
}

function effectiveThinking(model: ModelAlias, thinkingDraft: boolean): boolean {
  const availability = thinkingAvailability(model);
  if (availability === 'always-on') return true;
  if (availability === 'unsupported') return false;
  return thinkingDraft;
}

/**
 * Flat, searchable single-list model picker.
 *
 * One navigation axis: ↑/↓ move the cursor (PgUp/PgDn page), typing fuzzy-filters
 * across every provider (provider name included), and ←/→ toggle the thinking
 * draft for models that support it. There are no provider tabs — filtering by
 * typing a provider name replaces them. See .agents/skills/write-tui/DESIGN.md.
 */
export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  /** Per-model thinking override set by ←/→; absent → the capability default. */
  private readonly thinkingOverrides = new Map<string, boolean>();

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.alias === selectedValue);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  /**
   * Thinking draft for a model: an explicit ←/→ override when set, otherwise
   * the live thinking state for the active model, otherwise On for any other
   * thinking-capable model (a capable model should default to thinking on).
   */
  private draftFor(choice: ModelChoice): boolean {
    const override = this.thinkingOverrides.get(choice.alias);
    if (override !== undefined) return override;
    if (choice.alias === this.opts.currentValue) return this.opts.currentThinking;
    return thinkingAvailability(choice.model) !== 'unsupported';
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }

    // ↑/↓, PgUp/PgDn, and — when searchable — typing + Backspace.
    if (this.list.handleKey(data)) {
      return;
    }

    // Left/Right toggle the thinking draft for models that support it.
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const selected = this.selectedChoice();
      if (selected !== undefined && thinkingAvailability(selected.model) === 'toggle') {
        this.thinkingOverrides.set(selected.alias, !this.draftFor(selected));
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.selectedChoice();
      if (selected === undefined) return;
      this.opts.onSelect({
        alias: selected.alias,
        thinking: effectiveThinking(selected.model, this.draftFor(selected)),
      });
    }
  }

  override render(width: number): string[] {
    const { colors } = this.opts;
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const totalCount = Object.keys(this.opts.models).length;

    const titleSuffix =
      searchable && view.query.length === 0
        ? chalk.hex(colors.textMuted)('  (type to search)')
        : '';

    // "type to search" already lives in the title suffix, so the hint only
    // surfaces the backspace shortcut once a query is active.
    const hintParts: string[] = [];
    if (this.opts.providerSwitchHint) hintParts.push('Tab toggle provider');
    hintParts.push('↑↓ navigate');
    if (searchable && view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter select', 'Esc cancel');

    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Select a model') + titleSuffix,
      chalk.hex(colors.textMuted)(' ' + hintParts.join(' · ')),
      '',
    ];

    if (searchable && view.query.length > 0) {
      lines.push(chalk.hex(colors.primary)(' Search: ') + chalk.hex(colors.text)(view.query));
    }

    if (view.items.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('   No matches'));
    } else {
      // Column width for model names so the provider column lines up. Capped so
      // the provider + "← current" marker still fit on normal terminal widths.
      const nameCap = Math.max(8, Math.floor(width * 0.5));
      let nameWidth = 0;
      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(choice.name));
      }
      nameWidth = Math.min(nameWidth, nameCap);

      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        const isSelected = i === view.selectedIndex;
        const isCurrent = choice.alias === this.opts.currentValue;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const nameStyle = isSelected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
        const truncatedName = truncateToWidth(choice.name, nameWidth, '…');
        const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
        let line = chalk.hex(isSelected ? colors.primary : colors.textDim)(`  ${pointer} `);
        line += nameStyle(truncatedName) + namePad;
        line += '  ' + chalk.hex(colors.textMuted)(choice.provider);
        if (isCurrent) {
          line += ' ' + chalk.hex(colors.success)(CURRENT_MARK);
        }
        lines.push(line);
      }
    }

    // Scroll / match indicator.
    if (view.query.length > 0) {
      lines.push('');
      lines.push(
        chalk.hex(colors.textMuted)(` ${String(view.items.length)} / ${String(totalCount)}`),
      );
    } else {
      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(chalk.hex(colors.textMuted)(` ▼ ${String(below)} more`));
      }
    }

    lines.push('');
    const selected = this.selectedChoice();
    if (selected !== undefined) {
      const availability = thinkingAvailability(selected.model);
      const thinkingHeader = availability === 'toggle' ? ' Thinking  (←→ to switch)' : ' Thinking';
      lines.push(chalk.hex(colors.textMuted)(thinkingHeader));
      lines.push(this.renderThinkingControl(selected));
    }
    lines.push('');
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private selectedChoice(): ModelChoice | undefined {
    return this.list.selected();
  }

  private renderThinkingControl(choice: ModelChoice): string {
    const { colors } = this.opts;
    const segment = (label: string, active: boolean): string =>
      active
        ? chalk.hex(colors.primary).bold(`[ ${label} ]`)
        : chalk.hex(colors.text)(`  ${label}  `);

    const availability = thinkingAvailability(choice.model);
    if (availability === 'always-on') {
      return `  ${segment('Always on', true)}`;
    }
    if (availability === 'unsupported') {
      return `  ${segment('Off', true)} ${chalk.hex(colors.textMuted)('unsupported')}`;
    }
    const draft = this.draftFor(choice);
    return `  ${segment('On', draft)}  ${segment('Off', !draft)}`;
  }
}
