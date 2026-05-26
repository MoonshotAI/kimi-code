import { describe, expect, it } from 'vitest';

import { pageView } from '@/tui/utils/paging';

describe('pageView', () => {
  it('keeps the selected index on the first page', () => {
    expect(pageView(60, 3, 8)).toEqual({ page: 0, pageCount: 8, start: 0, end: 8 });
  });

  it('derives the page containing the selected index', () => {
    // index 12 with pageSize 8 lives on page 1 (items 8..15).
    expect(pageView(60, 12, 8)).toEqual({ page: 1, pageCount: 8, start: 8, end: 16 });
  });

  it('clamps the final page slice to the total', () => {
    // 60 items, pageSize 8 → last page is page 7 (items 56..59).
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
