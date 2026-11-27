import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import {
  DockSection,
  finishDialogLines,
  type DockLayout,
  type DockPart,
} from '#/tui/components/chrome/dock-section';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedMouse,
  handleSearchableListMouse,
  type MouseRowRegion,
} from '#/tui/utils/mouse-hit-test';
import { SearchableList } from '#/tui/utils/searchable-list';
import type { InlineSkillActivation } from '../../types';

const MAX_VISIBLE_CHOICES = 5;
const PREFERRED_SELECTED_OFFSET = 2;

export interface UndoChoice {
  readonly id: string;
  readonly count: number;
  readonly input: string;
  readonly inlineSkillActivations?: readonly InlineSkillActivation[];
  readonly label: string;
}

export interface UndoSelectorOptions {
  readonly choices: readonly UndoChoice[];
  readonly layout?: DockLayout;
  readonly onSelect: (choice: UndoChoice) => void;
  readonly onCancel: () => void;
}

export class UndoSelectorComponent extends DockSection implements Focusable {
  focused = false;
  private readonly opts: UndoSelectorOptions;
  private readonly list: SearchableList<UndoChoice>;
  private readonly shownAt = Date.now();
  private choiceRegions: readonly MouseRowRegion[] = [];
  private submitted = false;

  constructor(opts: UndoSelectorOptions) {
    super(opts.layout);
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
      const selectedIdx = this.list.view().selectedIndex;
      this.ensureBodyVisible(selectedIdx, selectedIdx + 1);
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

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedMouse(event);
    if (this.submitted) return { handled: true };

    if (this.layout === undefined && event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0;
      if (delta === 0) return { handled: true };
      const view = this.list.view();
      const next = Math.max(
        0,
        Math.min(view.items.length - 1, view.selectedIndex + (delta < 0 ? -1 : 1)),
      );
      const changed = next !== view.selectedIndex;
      this.list.moveTo(next);
      return { handled: true, render: changed };
    }

    if (part !== 'body') return undefined;

    return handleSearchableListMouse(this.list, {
      event,
      focused: this.focused,
      shownAt: this.shownAt,
      regions: this.choiceRegions,
      activate: (selected) => {
        this.submitted = true;
        this.opts.onSelect(selected);
      },
    });
  }

  protected renderPart(part: DockPart, width: number): string[] {
    switch (part) {
      case 'head': {
        const hintParts = ['↑↓ navigate', 'Enter select', 'Esc cancel'];
        return finishDialogLines(
          [
            currentTheme.fg('primary', '─'.repeat(width)),
            currentTheme.boldFg('primary', ' Select messages to undo'),
            currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
            '',
          ],
          width,
          this.focused,
        );
      }
      case 'body':
        return finishDialogLines(this.renderBody(width), width, this.focused);
      case 'foot':
        return finishDialogLines(
          ['', currentTheme.fg('primary', '─'.repeat(width))],
          width,
          this.focused,
        );
    }
  }

  private renderBody(width: number): string[] {
    const view = this.list.view();
    if (view.items.length === 0) {
      this.choiceRegions = [];
      return [currentTheme.fg('textMuted', '   No messages')];
    }

    let start = 0;
    let end = view.items.length;
    if (this.layout === undefined) {
      const visibleCount = Math.min(MAX_VISIBLE_CHOICES, view.items.length);
      const maxStart = view.items.length - visibleCount;
      start = Math.min(Math.max(0, view.selectedIndex - PREFERRED_SELECTED_OFFSET), maxStart);
      end = start + visibleCount;
    }

    const lines: string[] = [];
    const regions: MouseRowRegion[] = [];
    for (let i = start; i < end; i++) {
      const choice = view.items[i];
      if (choice === undefined) continue;
      const row = lines.length;
      lines.push(
        this.renderChoiceLine(choice, i === view.selectedIndex, i > view.selectedIndex, width),
      );
      regions.push({ start: row, end: lines.length, index: i });
    }
    this.choiceRegions = regions;
    return lines;
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
    line += isSelected ? currentTheme.boldFg(token, label) : currentTheme.fg(token, label);
    return line;
  }
}
