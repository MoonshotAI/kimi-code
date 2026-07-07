/**
 * Cursor + fuzzy-search + paging state machine shared by list pickers
 * (ChoicePicker, ModelSelector). Pure logic, no rendering.
 *
 * The component owns presentation and the keys that carry component-specific
 * meaning — Enter (submit), Esc (cancel), and ←/→ (paging in one picker, a
 * thinking toggle in another). This unit owns the keys that behave identically
 * everywhere: ↑/↓, PgUp/PgDn, and search editing.
 */

import { fuzzyFilter, Key, matchesKey } from '@moonshot-ai/pi-tui';

import { pageView, type PageView } from './paging';
import { isPrintableChar, printableChar } from './printable-key';

const DEFAULT_PAGE_SIZE = 8;

export interface SearchableListOptions<T> {
  readonly items: readonly T[];
  /** Text a list item is fuzzy-matched against. */
  readonly toSearchText: (item: T) => string;
  /** Items per page; defaults to 8. */
  readonly pageSize?: number;
  /** Initial cursor position (clamped to >= 0). */
  readonly initialIndex?: number;
  /** When false, typed characters are ignored. Defaults to false. */
  readonly searchable?: boolean;
}

export interface SearchableListView<T> {
  /** Items after the active query filter. */
  readonly items: readonly T[];
  /** Page math for the current cursor over {@link items}. */
  readonly page: PageView;
  /** Cursor clamped into the current {@link items} range. */
  readonly selectedIndex: number;
  readonly query: string;
}

export class SearchableList<T> {
  private readonly items: readonly T[];
  private readonly toSearchText: (item: T) => string;
  private readonly pageSize: number;
  private readonly searchable: boolean;
  private query = '';
  private cursor: number;

  constructor(opts: SearchableListOptions<T>) {
    this.items = opts.items;
    this.toSearchText = opts.toSearchText;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.searchable = opts.searchable ?? false;
    this.cursor = Math.max(opts.initialIndex ?? 0, 0);
  }

  filtered(): readonly T[] {
    if (this.query.length === 0) return this.items;
    return fuzzyFilter([...this.items], this.query, this.toSearchText);
  }

  /** The item under the cursor, clamped into the filtered range. */
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

  pageUp(): void {
    this.cursor = Math.max(0, this.cursor - this.pageSize);
  }

  pageDown(): void {
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + this.pageSize);
  }

  /** Clears the active query and resets the cursor. Returns whether a query was cleared. */
  clearQuery(): boolean {
    if (this.query.length === 0) return false;
    this.query = '';
    this.cursor = 0;
    return true;
  }

  /**
   * Handles the keys every picker shares: ↑/↓, PgUp/PgDn, and — when searchable —
   * Backspace and printable characters. Returns true when the key was consumed.
   * Enter, Esc, and ←/→ are intentionally left to the component.
   */
  handleKey(data: string): boolean {
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
        this.query = this.query.slice(0, -1);
        this.cursor = 0;
      }
      return true;
    }
    const ch = printableChar(data);
    if (isPrintableChar(ch)) {
      this.query += ch;
      this.cursor = 0;
      return true;
    }
    return false;
  }
}
