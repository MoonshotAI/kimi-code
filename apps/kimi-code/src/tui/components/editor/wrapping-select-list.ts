import {
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
} from '@moonshot-ai/pi-tui';

// Mirror pi-tui's private select-list layout constants
// (dist/components/select-list.js); keep in sync when bumping pi-tui.
const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const DESCRIPTION_MAX_LINES = 2;
const ELLIPSIS = '…';
const ELLIPSIS_WIDTH = visibleWidth(ELLIPSIS);

// truncateToWidth appends an ANSI reset whenever it actually truncates.
// Labels and descriptions here are plain text, and the reset would sit
// inside the theme's colour wrapping and reset the rest of the line (e.g.
// a selected row with a truncated name loses its colour after the name),
// so strip it.
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const TRAILING_ANSI_RESET = /(?:\u001B\[0m)+$/;

function truncatePlainToWidth(text: string, maxWidth: number): string {
  return truncateToWidth(text, maxWidth, '').replace(TRAILING_ANSI_RESET, '');
}

interface SelectListInternals {
  readonly filteredItems: SelectItem[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
  readonly theme: SelectListTheme;
  readonly layout: SelectListLayoutOptions;
}

/**
 * SelectList that wraps item descriptions onto up to two lines instead of
 * truncating them to one. Long command / skill descriptions stay readable;
 * anything past the second line is ellipsized.
 *
 * Only `render` is replaced — selection, filtering, and key handling stay in
 * pi-tui. pi-tui keeps the row state private, so the renderer reads it
 * through a cast, the same idiom CustomEditor uses for autocomplete
 * internals.
 */
export class WrappingSelectList extends SelectList {
  override render(width: number): string[] {
    const { filteredItems, selectedIndex, maxVisible, theme } = this.internals();
    if (filteredItems.length === 0) {
      return [theme.noMatch('  No matching commands')];
    }

    const primaryColumnWidth = this.primaryColumnWidth();
    const startIndex = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);

    const lines: string[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      const item = filteredItems[i];
      if (!item) continue;
      lines.push(...this.renderItemLines(item, i === selectedIndex, width, primaryColumnWidth));
    }

    if (startIndex > 0 || endIndex < filteredItems.length) {
      const scrollText = `  (${selectedIndex + 1}/${filteredItems.length})`;
      lines.push(theme.scrollInfo(truncatePlainToWidth(scrollText, width - 2)));
    }
    return lines;
  }

  private renderItemLines(
    item: SelectItem,
    isSelected: boolean,
    width: number,
    primaryColumnWidth: number,
  ): string[] {
    const { theme } = this.internals();
    const prefix = isSelected ? '→ ' : '  ';
    const prefixWidth = visibleWidth(prefix);
    const description = item.description
      ? item.description.replaceAll(/[\r\n]+/g, ' ').trim()
      : undefined;

    if (description && width > 40) {
      const effectivePrimaryColumnWidth = Math.max(
        1,
        Math.min(primaryColumnWidth, width - prefixWidth - 4),
      );
      const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
      const truncatedValue = this.truncatePrimaryValue(
        item,
        isSelected,
        maxPrimaryWidth,
        effectivePrimaryColumnWidth,
      );
      const truncatedValueWidth = visibleWidth(truncatedValue);
      const spacing = ' '.repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
      const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
      const remainingWidth = width - descriptionStart - 2; // -2 for safety, as upstream
      if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
        const descriptionLines = wrapDescription(description, remainingWidth);
        const indent = ' '.repeat(descriptionStart);
        if (isSelected) {
          return descriptionLines.map((line, index) =>
            theme.selectedText(index === 0 ? `${prefix}${truncatedValue}${spacing}${line}` : indent + line),
          );
        }
        return descriptionLines.map((line, index) =>
          index === 0
            ? prefix + truncatedValue + theme.description(spacing + line)
            : theme.description(indent + line),
        );
      }
    }

    const maxWidth = width - prefixWidth - 2;
    const truncatedValue = this.truncatePrimaryValue(item, isSelected, maxWidth, maxWidth);
    return [isSelected ? theme.selectedText(`${prefix}${truncatedValue}`) : prefix + truncatedValue];
  }

  private truncatePrimaryValue(
    item: SelectItem,
    isSelected: boolean,
    maxWidth: number,
    columnWidth: number,
  ): string {
    const { layout } = this.internals();
    const displayValue = item.label || item.value;
    const truncated = layout.truncatePrimary
      ? layout.truncatePrimary({ text: displayValue, maxWidth, columnWidth, item, isSelected })
      : displayValue;
    return truncatePlainToWidth(truncated, maxWidth);
  }

  private primaryColumnWidth(): number {
    const { filteredItems, layout } = this.internals();
    const rawMin =
      layout.minPrimaryColumnWidth ?? layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
    const rawMax =
      layout.maxPrimaryColumnWidth ?? layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
    const min = Math.max(1, Math.min(rawMin, rawMax));
    const max = Math.max(1, Math.max(rawMin, rawMax));
    const widest = filteredItems.reduce(
      (acc, item) => Math.max(acc, visibleWidth(item.label || item.value) + PRIMARY_COLUMN_GAP),
      0,
    );
    return Math.max(min, Math.min(widest, max));
  }

  private internals(): SelectListInternals {
    return this as unknown as SelectListInternals;
  }
}

/**
 * Wrap `text` to at most DESCRIPTION_MAX_LINES lines of `width` columns.
 * When the text needs more lines, the last visible line is rebuilt from the
 * remaining text and ellipsized.
 */
function wrapDescription(text: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(text, width);
  if (wrapped.length <= DESCRIPTION_MAX_LINES) {
    return wrapped;
  }
  const kept = wrapped.slice(0, DESCRIPTION_MAX_LINES - 1);
  const rest = wrapped.slice(DESCRIPTION_MAX_LINES - 1).join(' ');
  const clipped = truncatePlainToWidth(rest, width - ELLIPSIS_WIDTH).trimEnd();
  return [...kept, `${clipped}${ELLIPSIS}`];
}
