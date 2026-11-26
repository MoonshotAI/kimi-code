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
import {
  handleSearchableListMouse,
  type MouseRowRegion,
} from '#/tui/utils/dialog-mouse';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface AlignedChoiceItem<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
  readonly description?: string;
}

export abstract class AlignedChoiceDialogComponent<TValue extends string>
  implements Component, Focusable
{
  focused = false;
  private readonly list: SearchableList<AlignedChoiceItem<TValue>>;
  private readonly shownAt = Date.now();
  private choiceRegions: readonly MouseRowRegion[] = [];

  protected constructor(
    items: readonly AlignedChoiceItem<TValue>[],
    private readonly onSelect: (value: TValue) => void,
    private readonly onCancel: () => void,
  ) {
    this.list = new SearchableList({
      items,
      toSearchText: (option) => option.label,
      initialIndex: 0,
      searchable: false,
    });
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.onSelect(chosen.value);
      return;
    }
    this.list.handleKey(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return handleSearchableListMouse(this.list, {
      event,
      focused: this.focused,
      shownAt: this.shownAt,
      regions: this.choiceRegions,
      selectOnHover: false,
      activate: (chosen) => {
        this.onSelect(chosen.value);
      },
    });
  }

  render(width: number): string[] {
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      ...this.renderHeaderLines(width),
    ];
    this.choiceRegions = this.appendOptionRows(lines);
    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private appendOptionRows(lines: string[]): readonly MouseRowRegion[] {
    const view = this.list.view();
    const maxLabelWidth = Math.max(0, ...view.items.map((option) => visibleWidth(option.label)));
    const regions: MouseRowRegion[] = [];
    for (let i = view.page.start; i < view.page.end; i++) {
      const row = lines.length;
      const opt = view.items[i]!;
      const isSelected = i === view.selectedIndex;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += isSelected
        ? currentTheme.boldFg('primary', opt.label)
        : currentTheme.fg('text', opt.label);
      if (opt.description !== undefined) {
        const gap = maxLabelWidth - visibleWidth(opt.label) + 4;
        line += ' '.repeat(gap) + currentTheme.fg('textMuted', opt.description);
      }
      lines.push(line);
      regions.push({ start: row, end: lines.length, index: i });
    }
    return regions;
  }

  protected abstract renderHeaderLines(width: number): string[];
}
