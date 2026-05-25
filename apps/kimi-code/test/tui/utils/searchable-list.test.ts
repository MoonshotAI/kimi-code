import { describe, expect, it } from 'vitest';

import { SearchableList, type SearchableListOptions } from '#/tui/utils/searchable-list';

const ESC = String.fromCodePoint(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const BACKSPACE = String.fromCodePoint(127);

const ITEMS = Array.from({ length: 10 }, (_, i) => `item${String(i).padStart(2, '0')}`);

function make(over: Partial<SearchableListOptions<string>> = {}): SearchableList<string> {
  return new SearchableList<string>({
    items: ITEMS,
    toSearchText: (s) => s,
    pageSize: 4,
    ...over,
  });
}

describe('SearchableList', () => {
  it('derives page math from the cursor and pages by pageSize', () => {
    const list = make({ initialIndex: 0 });
    let v = list.view();
    expect(v.page.pageCount).toBe(3); // ceil(10 / 4)
    expect([v.page.start, v.page.end]).toEqual([0, 4]);
    expect(v.selectedIndex).toBe(0);

    list.pageDown();
    v = list.view();
    expect(v.selectedIndex).toBe(4);
    expect(v.page.page).toBe(1);

    list.pageUp();
    expect(list.view().page.page).toBe(0);
  });

  it('clamps the cursor at both ends', () => {
    const list = make({ initialIndex: 0 });
    list.moveUp(); // already at top
    expect(list.view().selectedIndex).toBe(0);

    for (let i = 0; i < 20; i++) list.moveDown();
    expect(list.view().selectedIndex).toBe(9); // last item

    list.pageDown(); // past the end stays clamped
    expect(list.view().selectedIndex).toBe(9);
  });

  it('selected() returns the item under the clamped cursor', () => {
    const list = make({ initialIndex: 2 });
    expect(list.selected()).toBe('item02');
    list.moveDown();
    expect(list.selected()).toBe('item03');
  });

  it('filters on the query, resets the cursor, and clearQuery restores the list', () => {
    const list = make({ initialIndex: 5, searchable: true });
    for (const ch of 'item09') list.handleKey(ch);

    let v = list.view();
    expect(v.query).toBe('item09');
    expect(v.items).toContain('item09');
    expect(v.items).not.toContain('item00');
    expect(v.selectedIndex).toBe(0);
    expect(list.selected()).toBe(v.items[0]);

    expect(list.clearQuery()).toBe(true);
    v = list.view();
    expect(v.query).toBe('');
    expect(v.items).toHaveLength(10);
    expect(list.clearQuery()).toBe(false); // nothing left to clear
  });

  it('trims the query on Backspace', () => {
    const list = make({ searchable: true });
    for (const ch of 'item0') list.handleKey(ch);
    expect(list.view().query).toBe('item0');
    list.handleKey(BACKSPACE);
    expect(list.view().query).toBe('item');
  });

  it('handleKey always consumes navigation but only edits the query when searchable', () => {
    const nav = make({ searchable: false });
    expect(nav.handleKey(UP)).toBe(true);
    expect(nav.handleKey(DOWN)).toBe(true);
    expect(nav.handleKey(PAGE_UP)).toBe(true);
    expect(nav.handleKey(PAGE_DOWN)).toBe(true);
    expect(nav.handleKey('a')).toBe(false); // not searchable → printable ignored
    expect(nav.handleKey(BACKSPACE)).toBe(false);
    expect(nav.view().query).toBe('');

    const search = make({ searchable: true });
    expect(search.handleKey('a')).toBe(true);
    expect(search.handleKey(BACKSPACE)).toBe(true);
    expect(search.view().query).toBe('');
  });
});
