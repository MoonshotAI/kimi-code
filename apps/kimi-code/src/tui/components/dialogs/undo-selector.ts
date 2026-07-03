import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

const MAX_VISIBLE_CHOICES = 5;
const PREFERRED_SELECTED_OFFSET = 2;

export interface UndoChoice {
  readonly id: string;
  readonly count: number;
  readonly input: string;
  readonly label: string;
}

export interface UndoSelectorOptions {
  readonly choices: readonly UndoChoice[];
  readonly onSelect: (choice: UndoChoice) => void;
  readonly onCancel: () => void;
}

export class UndoSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: UndoSelectorOptions;
  private readonly list: SearchableList<UndoChoice>;
  private submitted = false;

  constructor(opts: UndoSelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.choices,
      toSearchText: (choice) => choice.label,
      initialIndex: Math.max(0, opts.choices.length - 1),
    });
  }

  handleInput(data: string): void {
    if (this.submitted) return;

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    if (this.list.handleKey(data)) {
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        this.submitted = true;
        this.opts.onSelect(selected);
      }
    }
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const hintParts = ['↑↓ navigate', 'Enter select', 'Esc cancel'];

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Select messages to undo'),
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
      '',
    ];

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No messages'));
    } else {
      const visibleCount = Math.min(MAX_VISIBLE_CHOICES, view.items.length);
      const maxStart = view.items.length - visibleCount;
      const start = Math.min(
        Math.max(0, view.selectedIndex - PREFERRED_SELECTED_OFFSET),
        maxStart,
      );
      const end = start + visibleCount;

      for (let i = start; i < end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        lines.push(
          this.renderChoiceLine(choice, i === view.selectedIndex, i > view.selectedIndex, width),
        );
      }
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderChoiceLine(
    choice: UndoChoice,
    isSelected: boolean,
    inUndoRange: boolean,
    width: number,
  ): string {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const prefix = `  ${pointer} `;
    const labelBudget = Math.max(8, width - visibleWidth(prefix));
    const label = truncateToWidth(choice.label, labelBudget, '…');
    const token = isSelected ? 'primary' : inUndoRange ? 'textDim' : 'text';
    let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', prefix);
    line += isSelected
      ? currentTheme.boldFg(token, label)
      : currentTheme.fg(token, label);
    return line;
  }
}
