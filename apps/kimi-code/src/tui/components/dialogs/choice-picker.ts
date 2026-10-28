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
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';
import { Markdown } from '#/tui/components/markdown/markdown';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';
import { isSettlingClick } from '#/tui/utils/terminal-focus';

export interface ChoiceOption {
  /** Value passed to onSelect (e.g. the actual editor command string). */
  readonly value: string;
  /** Display text shown in the list. */
  readonly label: string;
  /** Optional semantic tone for labels that need stronger visual treatment. */
  readonly tone?: 'danger';
  /** Optional explanatory text shown below the label. */
  readonly description?: string | undefined;
  /** Color token applied to the description while this option is selected, drawing
   *  attention to important details. Falls back to `textMuted` when unset or not selected. */
  readonly descriptionTone?: ColorToken;
}

export interface ChoicePickerOptions {
  readonly title: string;
  readonly hint?: string;
  readonly formatHint?: (text: string) => string;
  /** Plain text shown in `noticeTone`, or Markdown rendered with the Markdown theme. */
  readonly notice?: string | { readonly markdown: string };
  /** Color tone for a plain-text notice. Defaults to 'success'. */
  readonly noticeTone?: 'success' | 'warning';
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  readonly initialValue?: string;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  readonly spaceSelect?: boolean;
  /** Items per page. Lists longer than this paginate. */
  readonly pageSize?: number;
  readonly onSelect: (value: string) => void;
  /** When provided, Alt+S invokes this with the selected value instead of
   * onSelect — used to apply the choice to the current session only. */
  readonly onSessionOnlySelect?: (value: string) => void;
  readonly onCancel: () => void;
}

interface ChoiceRegion {
  readonly start: number;
  readonly end: number;
  readonly index: number;
}

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

export class ChoicePickerComponent implements Component, Focusable {
  focused = false;
  private readonly opts: ChoicePickerOptions;
  private readonly list: SearchableList<ChoiceOption>;
  private readonly shownAt = Date.now();
  private choiceRegions: readonly ChoiceRegion[] = [];

  constructor(opts: ChoicePickerOptions) {
    this.opts = opts;
    const initialIdx = opts.options.findIndex(
      (o) => o.value === (opts.initialValue ?? opts.currentValue),
    );
    this.list = new SearchableList({
      items: opts.options,
      toSearchText: (o) => `${o.label} ${o.description ?? ''}`,
      pageSize: opts.pageSize,
      initialIndex: Math.max(initialIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSessionOnlySelect(chosen.value);
      return;
    }
    // Left/Right page through the list (this picker has no horizontal control).
    if (matchesKey(data, Key.left)) {
      this.list.pageUp();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.list.pageDown();
      return;
    }
    // Space confirmation is opt-out; searchable lists always route it to the query.
    const isSpace = matchesKey(data, Key.space) || printableChar(data) === ' ';
    if (
      matchesKey(data, Key.enter) ||
      (isSpace && this.opts.searchable !== true && this.opts.spaceSelect !== false)
    ) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
    this.list.handleKey(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) {
      if (event.type === 'press') return { handled: true };
      if (event.type === 'click') return { handled: true, focus: true };
      return undefined;
    }
    if (event.type === 'wheel') {
      const view = this.list.view();
      if (view.page.pageCount > 1 && event.wheelDelta !== undefined) {
        const before = view.selectedIndex;
        if (event.wheelDelta < 0) this.list.pageUp();
        else if (event.wheelDelta > 0) this.list.pageDown();
        return { handled: true, render: this.list.view().selectedIndex !== before };
      }
      return { handled: true };
    }
    if (event.type === 'move') {
      const index = this.choiceIndexAt(event.y);
      if (index === undefined) return undefined;
      return { handled: true, render: this.selectIndex(index) };
    }
    if (event.button !== 'left') return undefined;
    const index = this.choiceIndexAt(event.y);
    if (index === undefined) return undefined;
    if (event.type === 'press') {
      return { handled: true, render: this.selectIndex(index) };
    }
    if (event.type === 'click' && !isSettlingClick(this.shownAt)) {
      this.selectIndex(index);
      const chosen = this.list.view().items[index];
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
    }
    return { handled: true };
  }

  private choiceIndexAt(y: number): number | undefined {
    return this.choiceRegions.find((region) => y >= region.start && y < region.end)?.index;
  }

  private selectIndex(index: number): boolean {
    const changed = this.list.view().selectedIndex !== index;
    this.list.moveTo(index);
    return changed;
  }

  render(width: number): string[] {
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const options = view.items;

    // Header mirrors the model dialog (see model-selector.ts): border, title
    // with a "(type to search)" suffix until you type, the hint, a blank, then
    // the search line. Key vocabulary is lowercase to match every list dialog.
    const navParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) navParts.push('←→ page');
    navParts.push('Enter select', 'Esc cancel');
    const hint = this.opts.hint ?? navParts.join(' · ');

    const titleSuffix =
      searchable && view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintLines = hint.split(/\r?\n/);
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${this.opts.title}`) + titleSuffix,
    ];
    for (const hintLine of hintLines) {
      lines.push(
        this.opts.formatHint === undefined
          ? currentTheme.fg('textMuted', ` ${hintLine}`)
          : this.opts.formatHint(` ${hintLine}`),
      );
    }
    const notice = this.opts.notice;
    if (typeof notice === 'object') {
      const markdown = new Markdown(
        notice.markdown,
        0,
        0,
        createMarkdownTheme(),
        undefined,
        createMarkdownOptions(),
      );
      lines.push('');
      lines.push(...markdown.render(Math.max(1, width - 1)).map((line) => ` ${line}`));
    } else if (notice !== undefined) {
      const tone = this.opts.noticeTone ?? 'success';
      const noticeWidth = Math.max(1, width - 1);
      lines.push('');
      for (const noticeLine of notice.split(/\r?\n/)) {
        for (const wrapped of wrapDescription(noticeLine, noticeWidth)) {
          lines.push(currentTheme.fg(tone, ` ${wrapped}`));
        }
      }
    }
    lines.push('');
    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ` Search: `) + currentTheme.fg('text', view.query));
    }

    if (options.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    }
    const choiceRegions: ChoiceRegion[] = [];
    for (let i = view.page.start; i < view.page.end; i++) {
      const start = lines.length;
      const opt = options[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = opt.value === this.opts.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const labelStyle = optionLabelStyle(opt, isSelected);
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += labelStyle(opt.label);
      if (isCurrent) {
        line += ' ' + currentTheme.fg('success', CURRENT_MARK);
      }
      lines.push(line);
      if (opt.description !== undefined && opt.description.length > 0) {
        const descriptionWidth = Math.max(1, width - 4);
        const descriptionColor =
          isSelected && opt.descriptionTone !== undefined ? opt.descriptionTone : 'textMuted';
        for (const descLine of wrapDescription(opt.description, descriptionWidth)) {
          lines.push(currentTheme.fg(descriptionColor, `    ${descLine}`));
        }
      }
      choiceRegions.push({ start, end: lines.length, index: i });
    }
    this.choiceRegions = choiceRegions;

    lines.push('');
    if (view.page.pageCount > 1) {
      lines.push(
        currentTheme.fg('textMuted',
          ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
        ),
      );
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    const rendered = lines.map((line) => truncateToWidth(line, width));
    return this.focused ? rendered : rendered.map((line) => currentTheme.fade(line));
  }
}

function optionLabelStyle(
  option: ChoiceOption,
  selected: boolean,
): (text: string) => string {
  if (option.tone === 'danger') {
    return selected
      ? (text) => currentTheme.boldFg('error', text)
      : (text) => currentTheme.fg('error', text);
  }
  return selected
    ? (text) => currentTheme.boldFg('primary', text)
    : (text) => currentTheme.fg('text', text);
}
