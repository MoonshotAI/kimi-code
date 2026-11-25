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
    expect(v.page.pageCount).toBe(3);
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
    list.moveUp();
    expect(list.view().selectedIndex).toBe(0);

    for (let i = 0; i < 20; i++) list.moveDown();
    expect(list.view().selectedIndex).toBe(9);

    list.pageDown();
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
    expect(list.clearQuery()).toBe(false);
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
    expect(nav.handleKey('a')).toBe(false);
    expect(nav.handleKey(BACKSPACE)).toBe(false);
    expect(nav.view().query).toBe('');

    const search = make({ searchable: true });
    expect(search.handleKey('a')).toBe(true);
    expect(search.handleKey(BACKSPACE)).toBe(true);
    expect(search.view().query).toBe('');
  });

  it('appends bracketed pastes, chunked pastes, and multi-character text when searchable', () => {
    const list = make({ searchable: true });
    expect(list.handleKey(`${ESC}[200~item\r\n09${ESC}[201~`)).toBe(true);
    expect(list.view().query).toBe('item09');
    expect(list.selected()).toBe('item09');

    list.clearQuery();
    expect(list.handleKey(`${ESC}[200~it`)).toBe(true);
    expect(list.isPasting()).toBe(true);
    expect(list.handleKey('em\n')).toBe(true);
    expect(list.handleKey(`03${ESC}[201~`)).toBe(true);
    expect(list.isPasting()).toBe(false);
    expect(list.view().query).toBe('item03');

    list.clearQuery();
    expect(list.handleKey('item05')).toBe(true);
    expect(list.view().query).toBe('item05');
    expect(list.handleKey(`${ESC}[1;5D`)).toBe(false);
    expect(list.view().query).toBe('item05');
  });

  it('ignores bracketed pastes when not searchable', () => {
    const list = make({ searchable: false });
    expect(list.handleKey(`${ESC}[200~item09${ESC}[201~`)).toBe(false);
    expect(list.isPasting()).toBe(false);
    expect(list.view().query).toBe('');
  });

  it('setItems replaces the items, keeps the query, and clamps the cursor', () => {
    const list = make({ searchable: true });
    for (const ch of 'zz') list.handleKey(ch);
    list.setItems([...ITEMS, 'item10']);
    expect(list.view().query).toBe('zz');
    expect(list.view().items).toHaveLength(0);

    expect(list.clearQuery()).toBe(true);
    for (let i = 0; i < 20; i++) list.moveDown();
    expect(list.view().selectedIndex).toBe(10);

    list.setItems(['item00']);
    const v = list.view();
    expect(v.items).toEqual(['item00']);
    expect(v.selectedIndex).toBe(0);
    expect(list.selected()).toBe('item00');
  });

  it('selectIndex clamps against the filtered items and reports whether selection changed', () => {
    const list = make({ initialIndex: 0 });
    expect(list.selectIndex(0)).toBe(false);
    expect(list.selectIndex(2)).toBe(true);
    expect(list.view().selectedIndex).toBe(2);
    expect(list.selectIndex(2)).toBe(false);
    expect(list.selectIndex(99)).toBe(true);
    expect(list.view().selectedIndex).toBe(9);
    expect(list.selectIndex(-3)).toBe(true);
    expect(list.view().selectedIndex).toBe(0);

    const unclamped = make({ initialIndex: 99 });
    expect(unclamped.selectIndex(9)).toBe(false);
    expect(unclamped.selectIndex(8)).toBe(true);

    const empty = make({ items: [] });
    expect(empty.selectIndex(0)).toBe(false);
  });

  it('wheelPage turns multi-page lists and leaves single-page or boundary pages unchanged', () => {
    const list = make({ initialIndex: 2 });
    expect(list.wheelPage(0)).toBe(false);
    expect(list.wheelPage(-1)).toBe(false);
    expect(list.view().selectedIndex).toBe(2);

    expect(list.wheelPage(1)).toBe(true);
    expect(list.view().page.page).toBe(1);
    expect(list.view().selectedIndex).toBe(6);

    expect(list.wheelPage(1)).toBe(true);
    expect(list.view().page.page).toBe(2);
    expect(list.view().selectedIndex).toBe(9);

    expect(list.wheelPage(1)).toBe(false);
    expect(list.view().selectedIndex).toBe(9);

    expect(list.wheelPage(-1)).toBe(true);
    expect(list.view().page.page).toBe(1);
    expect(list.view().selectedIndex).toBe(5);

    const singlePage = make({ items: ['a', 'b', 'c'], pageSize: 4 });
    expect(singlePage.wheelPage(1)).toBe(false);
    expect(singlePage.wheelPage(-1)).toBe(false);
    expect(singlePage.view().selectedIndex).toBe(0);
  });
});
