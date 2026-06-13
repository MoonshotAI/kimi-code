import { Container, Key, matchesKey } from '@earendil-works/pi-tui';
import type { Focusable } from '@earendil-works/pi-tui';
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface CriticModelSelection {
  readonly modelAlias: string;
}

export interface CriticSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue?: string;
  readonly onSelect: (selection: CriticModelSelection) => void;
  readonly onCancel: () => void;
}

interface CriticChoice {
  readonly alias: string;
  readonly label: string;
}

function createChoices(models: Record<string, ModelAlias>): readonly CriticChoice[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    alias,
    label: `${cfg.displayName ?? cfg.model ?? alias} (${cfg.provider})`,
  }));
}

/**
 * A simple, focused model picker specifically for the critic subagent.
 * Shows available models; the user picks one for the critic role.
 */
export class CriticSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: CriticSelectorOptions;
  private readonly list: SearchableList<CriticChoice>;

  constructor(opts: CriticSelectorOptions) {
    super();
    this.opts = opts;
    const choices = createChoices(opts.models);
    const selectedIdx = opts.currentValue
      ? choices.findIndex((c) => c.alias === opts.currentValue)
      : -1;
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.label,
      pageSize: 10,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (this.list.handleKey(data)) return;
    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected === undefined) return;
      this.opts.onSelect({ modelAlias: selected.alias });
    }
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const totalCount = Object.keys(this.opts.models).length;

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Select a model for the critic agent') +
        (view.query.length === 0
          ? currentTheme.fg('textMuted', '  (type to search)')
          : ''),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc cancel'),
      '',
    ];

    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        const isSelected = i === view.selectedIndex;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const line =
          currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `) +
          (isSelected
            ? currentTheme.boldFg('primary', choice.label)
            : currentTheme.fg('text', choice.label));
        lines.push(line);
      }
    }

    if (view.query.length > 0) {
      lines.push('');
      lines.push(
        currentTheme.fg('textMuted', ` ${String(view.items.length)} / ${String(totalCount)}`),
      );
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines;
  }
}
