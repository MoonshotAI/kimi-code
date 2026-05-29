/**
 * Multi-select model picker used by /connect. Sibling to ModelSelectorComponent
 * (single-select, /model). Reuses SearchableList for cursor/search/paging and
 * the shared model-domain helpers in ./model-choice.
 */

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
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

import {
  createModelChoices,
  effectiveThinking,
  renderThinkingControl,
  thinkingAvailability,
  type ModelChoice,
} from './model-choice';

export interface ModelMultiSelection {
  /**
   * Checked model aliases, in the order the user checked them. Empty means the
   * user confirmed with nothing selected — a request to remove the channel
   * (only reachable when the picker was opened with `removable: true`).
   */
  readonly aliases: readonly string[];
  readonly defaultAlias?: string;
  readonly thinking: boolean;
}

export interface CatalogModelMultiSelectOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentThinking: boolean;
  readonly colors: ColorPalette;
  readonly selectedAliases?: readonly string[];
  readonly defaultAlias?: string;
  /**
   * When true, confirming with zero models checked is allowed and signals that
   * the channel should be removed. Used when re-entering an already-configured
   * provider. When false/undefined, Enter with nothing checked is a no-op.
   */
  readonly removable?: boolean;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate (PgUp/PgDn). */
  readonly pageSize?: number;
  readonly onSelect: (selection: ModelMultiSelection) => void;
  readonly onCancel: () => void;
}

export class CatalogModelMultiSelectComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: CatalogModelMultiSelectOptions;
  private readonly list: SearchableList<ModelChoice>;
  // Insertion order is preserved, so iteration yields the user's check order
  // and the first entry is the default model unless one is set explicitly.
  private readonly checked = new Set<string>();
  // The alias the user explicitly promoted to default via Tab. Cleared when
  // that alias is unchecked. Undefined → use first-checked.
  private explicitDefault?: string;
  private thinkingDraft: boolean;

  constructor(opts: CatalogModelMultiSelectOptions) {
    super();
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const availableAliases = new Set(choices.map((choice) => choice.alias));
    for (const alias of opts.selectedAliases ?? []) {
      if (availableAliases.has(alias)) this.checked.add(alias);
    }
    if (opts.defaultAlias !== undefined && this.checked.has(opts.defaultAlias)) {
      this.explicitDefault = opts.defaultAlias;
    }
    const initialAlias = this.defaultAlias();
    const initialIndex = choices.findIndex((choice) => choice.alias === initialAlias);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (c) => c.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(initialIndex, 0),
      searchable: opts.searchable === true,
    });
    this.thinkingDraft = opts.currentThinking;
  }

  /** Tab-promoted (if still checked) → first-checked → undefined. */
  private defaultAlias(): string | undefined {
    if (this.explicitDefault !== undefined && this.checked.has(this.explicitDefault)) {
      return this.explicitDefault;
    }
    return this.checked.values().next().value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    // Decode first — under Kitty CSI-u, Space isn't a raw ' '.
    if (printableChar(data) === ' ') {
      const highlighted = this.list.selected();
      if (highlighted !== undefined) this.toggle(highlighted.alias);
      return;
    }
    // Default must be among the written models, so promoting also checks.
    if (matchesKey(data, Key.tab)) {
      const highlighted = this.list.selected();
      if (highlighted !== undefined) this.setDefault(highlighted.alias);
      return;
    }
    // Left/Right toggle thinking for the default model (only when it supports
    // toggling); paging stays on PgUp/PgDn so the arrows control thinking.
    const targetAlias = this.defaultAlias();
    const target = targetAlias !== undefined ? this.opts.models[targetAlias] : undefined;
    if (target !== undefined && thinkingAvailability(target) === 'toggle') {
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
      this.submit();
      return;
    }
    this.list.handleKey(data);
  }

  private toggle(alias: string): void {
    if (this.checked.has(alias)) {
      this.checked.delete(alias);
      if (this.explicitDefault === alias) this.explicitDefault = undefined;
    } else {
      this.checked.add(alias);
    }
  }

  private setDefault(alias: string): void {
    // add() on an already-checked alias keeps its original position, so
    // promoting to default never reorders the written models.
    this.checked.add(alias);
    this.explicitDefault = alias;
  }

  private submit(): void {
    // Enter only confirms an already-built selection. Without an explicit
    // Space/Tab the picker stays open — never silently include the highlighted
    // row, since that would contradict the "only the models you check are
    // written" guarantee.
    if (this.checked.size === 0) {
      // For an already-configured provider, confirming with nothing checked
      // means "remove this channel". Otherwise there is nothing to do.
      if (this.opts.removable === true) {
        this.opts.onSelect({ aliases: [], defaultAlias: undefined, thinking: this.thinkingDraft });
      }
      return;
    }
    const aliases = [...this.checked];
    const defaultAlias = this.defaultAlias();
    if (defaultAlias === undefined) return;
    const thinking = effectiveThinking(this.opts.models[defaultAlias]!, this.thinkingDraft);
    this.opts.onSelect({ aliases, defaultAlias, thinking });
  }

  override render(width: number): string[] {
    const { colors } = this.opts;
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const choices = view.items;
    const defaultAlias = this.defaultAlias();

    const navParts = ['↑↓ navigate', 'Space select', 'Tab default', '←→ thinking'];
    if (view.page.pageCount > 1) navParts.push('PgUp/PgDn page');
    navParts.push('Enter confirm', 'Esc cancel');

    const titleSuffix =
      searchable && view.query.length === 0 ? chalk.hex(colors.textMuted)('  (type to search)') : '';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Select one or more models') + titleSuffix,
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
      const isHighlighted = i === view.selectedIndex;
      const isChecked = this.checked.has(choice.alias);
      const pointer = isHighlighted ? '❯' : ' ';
      const checkbox = isChecked ? '[x]' : '[ ]';
      const labelStyle = isHighlighted ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
      let line = chalk.hex(isHighlighted ? colors.primary : colors.textDim)(`  ${pointer} `);
      line += chalk.hex(isChecked ? colors.success : colors.textDim)(`${checkbox} `);
      line += labelStyle(choice.label);
      if (choice.alias === defaultAlias && this.checked.size > 0) {
        line += ' ' + chalk.hex(colors.success)('← default');
      }
      lines.push(line);
    }

    lines.push('');
    if (this.checked.size === 0) {
      lines.push(
        chalk.hex(colors.textMuted)(
          this.opts.removable === true
            ? ' Deselect all and press Enter to remove this channel — or Space to keep models.'
            : ' Press Space to select at least one model — Tab makes the highlighted one the default.',
        ),
      );
    } else {
      lines.push(chalk.hex(colors.textMuted)(' Thinking'));
      // checked.size > 0 here, so defaultAlias() returns a checked alias and that
      // alias is always a key in opts.models (checked is filtered by availableAliases).
      lines.push(renderThinkingControl(this.opts.models[defaultAlias!]!, this.thinkingDraft, colors));
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
