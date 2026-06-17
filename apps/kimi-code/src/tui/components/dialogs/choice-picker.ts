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
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface ChoiceOption {
  /** Value passed to onSelect (e.g. the actual editor command string). */
  readonly value: string;
  /** Display text shown in the list. */
  readonly label: string;
  /** Optional semantic tone for labels that need stronger visual treatment. */
  readonly tone?: 'danger';
  readonly labelAnimation?: 'wave';
  /** Optional explanatory text shown below the label. */
  readonly description?: string | undefined;
  /**
   * Fully custom row renderer. When set, the picker renders these lines for the
   * option (first line follows the pointer, the rest are indented) instead of
   * the default styled label + description. `width` is the content width.
   */
  readonly render?: (selected: boolean, width: number) => readonly string[];
  /** Text the option is fuzzy-matched against; defaults to label + description. */
  readonly searchText?: string;
}

export interface ChoicePickerOptions {
  readonly title: string;
  readonly hint?: string;
  readonly formatHint?: (text: string) => string;
  readonly notice?: string;
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate. */
  readonly pageSize?: number;
  /**
   * When true, the list scrolls continuously (a window that slides with the
   * cursor) instead of paginating — no page numbers, no total count. Use for
   * lists where the loaded set is deliberately capped, so pagination would
   * misleadingly imply completeness.
   */
  readonly scroll?: boolean;
  /** Note shown once the bottom of a `scroll` list is reached. */
  readonly endHint?: string;
  readonly optionSpacing?: 'compact' | 'relaxed';
  readonly requestRender?: () => void;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

const WAVE_LABEL_TOKENS: readonly ColorToken[] = ['primary', 'accent', 'success'];
const WAVE_LABEL_INTERVAL_MS = 120;
/** Visible rows for a scroll-mode list when no pageSize is given. */
const DEFAULT_VISIBLE = 8;

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

export class ChoicePickerComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ChoicePickerOptions;
  private readonly list: SearchableList<ChoiceOption>;
  private animationPhase = 0;
  private animationTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: ChoicePickerOptions) {
    super();
    this.opts = opts;
    const currentIdx = opts.options.findIndex((o) => o.value === opts.currentValue);
    this.list = new SearchableList({
      items: opts.options,
      toSearchText: (o) => o.searchText ?? `${o.label} ${o.description ?? ''}`,
      pageSize: opts.pageSize,
      initialIndex: Math.max(currentIdx, 0),
      searchable: opts.searchable === true,
    });
    if (opts.requestRender !== undefined && opts.options.some((option) => option.labelAnimation === 'wave')) {
      this.animationTimer = setInterval(() => {
        this.animationPhase = (this.animationPhase + 1) % WAVE_LABEL_TOKENS.length;
        opts.requestRender?.();
      }, WAVE_LABEL_INTERVAL_MS);
      (this.animationTimer as { unref?: () => void }).unref?.();
    }
  }

  dispose(): void {
    if (this.animationTimer !== undefined) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
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
    // Enter always selects. Space selects too — but only when the list is not
    // searchable; in a searchable list a space must reach the query instead.
    const isSpace = matchesKey(data, Key.space) || printableChar(data) === ' ';
    if (matchesKey(data, Key.enter) || (isSpace && this.opts.searchable !== true)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const searchable = this.opts.searchable === true;
    const scroll = this.opts.scroll === true;
    const view = this.list.view();
    const options = view.items;

    // In scroll mode the window slides with the cursor; otherwise it paginates.
    const windowSize = Math.max(1, this.opts.pageSize ?? DEFAULT_VISIBLE);
    const start = scroll
      ? Math.min(Math.max(0, view.selectedIndex - Math.floor(windowSize / 2)), Math.max(0, options.length - windowSize))
      : view.page.start;
    const end = scroll ? Math.min(start + windowSize, options.length) : view.page.end;

    // Header mirrors the model dialog (see model-selector.ts): border, title
    // with a "(type to search)" suffix until you type, the hint, a blank, then
    // the search line. Key vocabulary is lowercase to match every list dialog.
    const navParts = ['↑↓ navigate'];
    if (!scroll && view.page.pageCount > 1) navParts.push('←→ page');
    navParts.push('Enter select', 'Esc cancel');
    const hint = this.opts.hint ?? navParts.join(' · ');

    const titleSuffix =
      searchable && view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${this.opts.title}`) + titleSuffix,
      this.opts.formatHint === undefined
        ? currentTheme.fg('textMuted', ` ${hint}`)
        : this.opts.formatHint(` ${hint}`),
    ];
    if (this.opts.notice !== undefined) {
      lines.push(currentTheme.fg('success', ` ${this.opts.notice}`));
    }
    lines.push('');
    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ` Search: `) + currentTheme.fg('text', view.query));
    }

    if (options.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    }
    for (let i = start; i < end; i++) {
      const opt = options[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = opt.value === this.opts.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const prefix = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      if (opt.render !== undefined) {
        const rendered = opt.render(isSelected, Math.max(1, width - 4));
        let first = prefix + (rendered[0] ?? '');
        if (isCurrent) first += ' ' + currentTheme.fg('success', CURRENT_MARK);
        lines.push(first);
        for (const extra of rendered.slice(1)) lines.push('    ' + extra);
        if (this.opts.optionSpacing === 'relaxed' && i < end - 1) lines.push('');
        continue;
      }
      const labelStyle = optionLabelStyle(opt, isSelected, this.animationPhase);
      let line = prefix;
      line += labelStyle(opt.label);
      if (isCurrent) {
        line += ' ' + currentTheme.fg('success', CURRENT_MARK);
      }
      lines.push(line);
      if (opt.description !== undefined && opt.description.length > 0) {
        const descriptionWidth = Math.max(1, width - 4);
        for (const descLine of wrapDescription(opt.description, descriptionWidth)) {
          lines.push(currentTheme.fg('textMuted', `    ${descLine}`));
        }
      }
      if (this.opts.optionSpacing === 'relaxed' && i < end - 1) {
        lines.push('');
      }
    }

    lines.push('');
    if (scroll) {
      if (end < options.length) {
        lines.push(currentTheme.fg('textMuted', '   ↓ more'));
      } else if (this.opts.endHint !== undefined && options.length > 0) {
        lines.push(currentTheme.fg('textMuted', `   ${this.opts.endHint}`));
      }
    } else if (view.page.pageCount > 1) {
      lines.push(
        currentTheme.fg('textMuted',
          ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
        ),
      );
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function optionLabelStyle(
  option: ChoiceOption,
  selected: boolean,
  animationPhase: number,
): (text: string) => string {
  if (option.labelAnimation === 'wave') {
    return (text) => waveLabel(text, animationPhase, selected);
  }
  if (option.tone === 'danger') {
    return selected
      ? (text) => currentTheme.boldFg('error', text)
      : (text) => currentTheme.fg('error', text);
  }
  return selected
    ? (text) => currentTheme.boldFg('primary', text)
    : (text) => currentTheme.fg('text', text);
}

function waveLabel(text: string, phase: number, selected: boolean): string {
  let visibleIndex = 0;
  let rendered = '';
  for (const char of Array.from(text)) {
    if (char === ' ') {
      rendered += char;
      continue;
    }
    const token = WAVE_LABEL_TOKENS[(visibleIndex + phase) % WAVE_LABEL_TOKENS.length]!;
    rendered += currentTheme.fg(token, char);
    visibleIndex += 1;
  }
  return selected ? currentTheme.bold(rendered) : rendered;
}
