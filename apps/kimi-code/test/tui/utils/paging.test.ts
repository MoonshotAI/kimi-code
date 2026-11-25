import { describe, expect, it } from 'vitest';

import { pageView, StableWindow } from '#/tui/utils/paging';

describe('pageView', () => {
  it('keeps the selected index on the first page', () => {
    expect(pageView(60, 3, 8)).toEqual({ page: 0, pageCount: 8, start: 0, end: 8 });
  });

  it('derives the page containing the selected index', () => {
    expect(pageView(60, 12, 8)).toEqual({ page: 1, pageCount: 8, start: 8, end: 16 });
  });

  it('clamps the final page slice to the total', () => {
    expect(pageView(60, 59, 8)).toEqual({ page: 7, pageCount: 8, start: 56, end: 60 });
  });

  it('clamps a selectedIndex past the end onto the last page', () => {
    expect(pageView(10, 999, 4)).toEqual({ page: 2, pageCount: 3, start: 8, end: 10 });
  });

  it('clamps a negative selectedIndex to the first page', () => {
    expect(pageView(10, -5, 4)).toEqual({ page: 0, pageCount: 3, start: 0, end: 4 });
  });

  it('returns a single page when pageSize exceeds the total', () => {
    expect(pageView(5, 4, 8)).toEqual({ page: 0, pageCount: 1, start: 0, end: 5 });
  });

  it('returns a single empty page for an empty list', () => {
    expect(pageView(0, 0, 8)).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
  });

  it('treats a non-positive pageSize as size 1', () => {
    expect(pageView(3, 2, 0)).toEqual({ page: 2, pageCount: 3, start: 2, end: 3 });
  });
});

describe('StableWindow', () => {
  it('keeps the viewport stationary while the selected index stays visible and shifts minimally when it leaves', () => {
    const win = new StableWindow();
    expect(win.offset).toBe(0);
    expect(win.range(10, 4)).toEqual({ start: 0, end: 4 });

    win.ensureVisible(3, 10, 4);
    expect(win.offset).toBe(0);

    win.ensureVisible(4, 10, 4);
    expect(win.offset).toBe(1);
    expect(win.range(10, 4)).toEqual({ start: 1, end: 5 });

    win.ensureVisible(2, 10, 4);
    expect(win.offset).toBe(1);

    win.ensureVisible(0, 10, 4);
    expect(win.offset).toBe(0);

    win.ensureVisible(9, 10, 4);
    expect(win.offset).toBe(6);
    expect(win.range(10, 4)).toEqual({ start: 6, end: 10 });
  });

  it('scrolls by delta within clamped bounds and reports whether the offset changed', () => {
    const win = new StableWindow(2);
    expect(win.scrollBy(0, 10, 4)).toBe(false);
    expect(win.scrollBy(2, 10, 4)).toBe(true);
    expect(win.offset).toBe(4);
    expect(win.scrollBy(10, 10, 4)).toBe(true);
    expect(win.offset).toBe(6);
    expect(win.scrollBy(1, 10, 4)).toBe(false);
    expect(win.scrollBy(-10, 10, 4)).toBe(true);
    expect(win.offset).toBe(0);
    expect(win.scrollBy(-1, 10, 4)).toBe(false);
  });

  it('clamps cleanly when total shrinks, list empties, or reset is called', () => {
    const win = new StableWindow(8);
    expect(win.range(5, 4)).toEqual({ start: 1, end: 5 });
    expect(win.offset).toBe(1);
    expect(win.range(0, 4)).toEqual({ start: 0, end: 0 });
    expect(win.offset).toBe(0);

    win.reset(3);
    expect(win.offset).toBe(3);
    win.reset();
    expect(win.offset).toBe(0);
  });
});
