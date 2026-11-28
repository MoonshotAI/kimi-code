import { fuzzyFilter, Key, matchesKey } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

import { pageView, type PageView } from './paging';
import { printableChar } from './printable-key';

const DEFAULT_PAGE_SIZE = 8;
const BRACKET_PASTE_START = '\u001B[200~';
const BRACKET_PASTE_END = '\u001B[201~';
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function removeLastGrapheme(text: string): string {
  const segments = Array.from(GRAPHEME_SEGMENTER.segment(text), (entry) => entry.segment);
  return segments.slice(0, -1).join('');
}

function isPrintableText(text: string): boolean {
  if (text.length === 0) return false;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function cleanPastedText(text: string): string {
  const normalized = text.replace(/\r\n|\r|\n/g, '').replace(/\t/g, ' ');
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

export interface SearchableListOptions<T> {
  readonly items: readonly T[];
  readonly toSearchText: (item: T) => string;
  readonly pageSize?: number;
  readonly initialIndex?: number;
  readonly searchable?: boolean;
}

export interface SearchableListView<T> {
  readonly items: readonly T[];
  readonly page: PageView;
  readonly selectedIndex: number;
  readonly query: string;
}

export class SearchableList<T> {
  private items: readonly T[];
  private readonly toSearchText: (item: T) => string;
  private readonly pageSize: number;
  private readonly searchable: boolean;
  private query = '';
  private cursor: number;
  private inPaste = false;
  private pasteBuffer = '';

  constructor(opts: SearchableListOptions<T>) {
    this.items = opts.items;
    this.toSearchText = opts.toSearchText;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.searchable = opts.searchable ?? false;
    this.cursor = Math.max(opts.initialIndex ?? 0, 0);
  }

  isPasting(): boolean {
    return this.inPaste;
  }

  setItems(items: readonly T[]): void {
    this.items = items;
    this.cursor = Math.min(this.cursor, Math.max(0, items.length - 1));
  }

  filtered(): readonly T[] {
    if (this.query.length === 0) return this.items;
    return fuzzyFilter([...this.items], this.query, this.toSearchText);
  }

  selected(): T | undefined {
    const items = this.filtered();
    if (items.length === 0) return undefined;
    return items[Math.min(this.cursor, items.length - 1)];
  }

  view(): SearchableListView<T> {
    const items = this.filtered();
    return {
      items,
      page: pageView(items.length, this.cursor, this.pageSize),
      selectedIndex: Math.min(this.cursor, Math.max(0, items.length - 1)),
      query: this.query,
    };
  }

  moveUp(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  moveDown(): void {
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + 1);
  }

  moveTo(index: number): void {
    this.cursor = Math.max(0, Math.min(index, this.filtered().length - 1));
  }

  pageUp(): void {
    this.cursor = Math.max(0, this.cursor - this.pageSize);
  }

  pageDown(): void {
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + this.pageSize);
  }

  clearQuery(): boolean {
    if (this.query.length === 0) return false;
    this.query = '';
    this.cursor = 0;
    return true;
  }

  handleKey(data: string): boolean {
    if (this.searchable && (this.inPaste || data.includes(BRACKET_PASTE_START))) {
      return this.handleBracketedPaste(data);
    }
    if (matchesKey(data, Key.up)) {
      this.moveUp();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.moveDown();
      return true;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.pageUp();
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.pageDown();
      return true;
    }
    if (!this.searchable) return false;
    if (matchesKey(data, Key.backspace)) {
      if (this.query.length > 0) {
        this.query = removeLastGrapheme(this.query);
        this.cursor = 0;
      }
      return true;
    }
    const text = printableChar(data);
    if (isPrintableText(text)) {
      this.query += text;
      this.cursor = 0;
      return true;
    }
    return false;
  }

  private handleBracketedPaste(data: string): boolean {
    let chunk = data;
    if (!this.inPaste) {
      const startIndex = chunk.indexOf(BRACKET_PASTE_START);
      const prefix = chunk.slice(0, startIndex);
      if (prefix.length > 0) this.handleKey(prefix);
      this.inPaste = true;
      this.pasteBuffer = '';
      chunk = chunk.slice(startIndex + BRACKET_PASTE_START.length);
    }
    this.pasteBuffer += chunk;
    const endIndex = this.pasteBuffer.indexOf(BRACKET_PASTE_END);
    if (endIndex === -1) return true;
    const pasted = cleanPastedText(this.pasteBuffer.slice(0, endIndex));
    const remaining = this.pasteBuffer.slice(endIndex + BRACKET_PASTE_END.length);
    this.inPaste = false;
    this.pasteBuffer = '';
    if (pasted.length > 0) {
      this.query += pasted;
      this.cursor = 0;
    }
    if (remaining.length > 0) this.handleKey(remaining);
    return true;
  }
}

export function renderSearchableListStatus(
  view: SearchableListView<unknown>,
  searchable = true,
): string[] {
  const lines: string[] = [];
  if (searchable && view.query.length > 0) {
    lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
  }
  if (view.items.length === 0) {
    lines.push(currentTheme.fg('textMuted', '   No matches'));
  }
  return lines;
}
