import { fuzzyFilter, Key, matchesKey } from '@moonshot-ai/pi-tui';

import { pageView, type PageView } from './paging';
import { isPrintableChar, printableChar } from './printable-key';

const DEFAULT_PAGE_SIZE = 8;

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

  constructor(opts: SearchableListOptions<T>) {
    this.items = opts.items;
    this.toSearchText = opts.toSearchText;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.searchable = opts.searchable ?? false;
    this.cursor = Math.max(opts.initialIndex ?? 0, 0);
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
