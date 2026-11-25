import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { ListMouseTracker } from '#/tui/utils/mouse-regions';
import { StableWindow } from '#/tui/utils/paging';
import type { InlineSkillActivation } from '../../types';
import { SearchableList } from '#/tui/utils/searchable-list';

const MAX_VISIBLE_CHOICES = 5;

export interface UndoChoice {
  readonly id: string;
  readonly count: number;
  readonly input: string;
  readonly inlineSkillActivations?: readonly InlineSkillActivation[];
  readonly label: string;
}

export interface UndoSelectorOptions {
  readonly choices: readonly UndoChoice[];
  readonly onSelect: (choice: UndoChoice) => void;
  readonly onCancel: () => void;
}

export class UndoSelectorComponent implements Component, Focusable {
  focused = false;
  private readonly opts: UndoSelectorOptions;
  private readonly list: SearchableList<UndoChoice>;
  private readonly window = new StableWindow();
  private readonly mouse = new ListMouseTracker<number>();
  private submitted = false;

  constructor(opts: UndoSelectorOptions) {
    this.opts = opts;
    const initialIndex = Math.max(0, opts.choices.length - 1);
    this.list = new SearchableList({
      items: opts.choices,
      toSearchText: (choice) => choice.label,
      pageSize: MAX_VISIBLE_CHOICES,
      initialIndex,
    });
    this.window.ensureVisible(initialIndex, opts.choices.length, MAX_VISIBLE_CHOICES);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.submitted) return;

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    if (this.list.handleKey(data)) {
      const view = this.list.view();
      this.window.ensureVisible(view.selectedIndex, view.items.length, MAX_VISIBLE_CHOICES);
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

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.submitted) return undefined;
    return this.mouse.handle(event, {
      focused: this.focused,
      onHover: (index) => this.list.selectIndex(index),
      onWheel: (delta) => {
        if (!Number.isFinite(delta) || delta === 0) return false;
        const view = this.list.view();
        const moved = this.window.scrollBy(
          delta > 0 ? 1 : -1,
          view.items.length,
          MAX_VISIBLE_CHOICES,
        );
        if (!moved) return false;
        const { start, end } = this.window.range(view.items.length, MAX_VISIBLE_CHOICES);
        if (end > start) {
          const clamped = Math.min(Math.max(view.selectedIndex, start), end - 1);
          this.list.selectIndex(clamped);
        }
        return true;
      },
      onActivate: (index) => {
        this.list.selectIndex(index);
        const selected = this.list.view().items[index];
        if (selected !== undefined && !this.submitted) {
          this.submitted = true;
          this.opts.onSelect(selected);
        }
      },
    });
  }

  render(width: number): string[] {
    this.mouse.reset();
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
      const { start, end } = this.window.range(view.items.length, MAX_VISIBLE_CHOICES);

      for (let i = start; i < end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        this.mouse.track(lines, i, () => {
          lines.push(
            this.renderChoiceLine(choice, i === view.selectedIndex, i > view.selectedIndex, width),
          );
        });
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
