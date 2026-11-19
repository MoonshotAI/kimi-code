import { describe, expect, it } from 'vitest';
import {
  PINNED_HANDLE_ROW_THRESHOLD,
  PINNED_ROW_HEIGHT,
  PINNED_ROWS_MIN_HEIGHT,
  isNoopGesture,
  pinnedRowsDefaultHeight,
  pinnedRowsKeyboardTarget,
  pinnedRowsMaxHeight,
  pinnedRowsMinHeight,
  pinnedRowsResizeCeiling,
  pinnedSectionResizable,
  SESSIONS_LIST_MIN_HEIGHT,
  measureSessionsListRows,
  sessionsListMinHeight,
} from '../src/lib/pinnedSectionLayout';

describe('pinnedSectionResizable', () => {
  it('hides the handle while the pinned content fits the compact threshold', () => {
    expect(pinnedSectionResizable(0)).toBe(false);
    expect(pinnedSectionResizable(1)).toBe(false);
    expect(pinnedSectionResizable(PINNED_HANDLE_ROW_THRESHOLD)).toBe(false);
  });

  it('shows the handle once the content exceeds the threshold', () => {
    expect(pinnedSectionResizable(PINNED_HANDLE_ROW_THRESHOLD + 1)).toBe(true);
    expect(pinnedSectionResizable(20)).toBe(true);
  });
});

describe('pinned section drag bounds', () => {
  it('never shrinks below two full rows', () => {
    expect(PINNED_ROWS_MIN_HEIGHT).toBe(PINNED_ROW_HEIGHT * 2);
  });

  it('defaults to the historical 40vh cap', () => {
    expect(pinnedRowsDefaultHeight(1000)).toBe(400);
    expect(pinnedRowsDefaultHeight(768)).toBe(307);
  });

  it('caps the drag at 60% of the viewport when no split budget is measured', () => {
    expect(pinnedRowsMaxHeight(1000)).toBe(600);
    expect(pinnedRowsMaxHeight(768)).toBe(461);
    expect(pinnedRowsMaxHeight(768, undefined)).toBe(461);
    expect(pinnedRowsMaxHeight(768, Number.NaN)).toBe(461);
  });

  it('floors the viewport cap at the min height on tiny windows', () => {
    expect(pinnedRowsMaxHeight(100)).toBe(PINNED_ROWS_MIN_HEIGHT);
    expect(pinnedRowsMaxHeight(0)).toBe(PINNED_ROWS_MIN_HEIGHT);
  });

  it('lets the split budget bind below the viewport cap on short sidebars', () => {
    expect(pinnedRowsMaxHeight(1000, 400)).toBe(400 - SESSIONS_LIST_MIN_HEIGHT);
  });

  it('lets the viewport cap bind when the budget is roomy', () => {
    expect(pinnedRowsMaxHeight(768, 5000)).toBe(461);
  });

  it('floors the budget cap at the min height when the budget is tiny', () => {
    expect(pinnedRowsMaxHeight(1000, SESSIONS_LIST_MIN_HEIGHT)).toBe(PINNED_ROWS_MIN_HEIGHT);
    expect(pinnedRowsMaxHeight(1000, 0)).toBe(PINNED_ROWS_MIN_HEIGHT);
  });

  it('floors at the DYNAMIC min height: short window + large font scale', () => {
    expect(pinnedRowsMaxHeight(480, 210, 122)).toBe(122);
    expect(pinnedRowsMaxHeight(100, undefined, 122)).toBe(122);
    expect(pinnedRowsMaxHeight(480, 210, Number.NaN)).toBe(114);
  });

  it('keeps the bounds ordered on any sane viewport', () => {
    for (const vh of [0, 200, 400, 768, 1200, 3000]) {
      const min = PINNED_ROWS_MIN_HEIGHT;
      const def = pinnedRowsDefaultHeight(vh);
      const max = pinnedRowsMaxHeight(vh);
      expect(max).toBeGreaterThanOrEqual(min);
      if (def >= min) expect(def).toBeLessThanOrEqual(max);
    }
  });

  it('keeps min ≤ max across font scales, viewports and budgets', () => {
    for (const rowHeight of [undefined, 43, 50, 57, 61]) {
      const min = pinnedRowsMinHeight(rowHeight === undefined ? undefined : [rowHeight, rowHeight]);
      for (const vh of [100, 480, 768, 3000]) {
        for (const budget of [undefined, 0, 210, 5000]) {
          for (const keep of [undefined, 96, 195]) {
            expect(pinnedRowsMaxHeight(vh, budget, min, keep)).toBeGreaterThanOrEqual(min);
          }
        }
      }
    }
  });
});

describe('sessionsListMinHeight', () => {
  it('falls back to the default-scale keep unless the padding and a height input are measured', () => {
    expect(sessionsListMinHeight()).toBe(SESSIONS_LIST_MIN_HEIGHT);
    expect(sessionsListMinHeight(150)).toBe(SESSIONS_LIST_MIN_HEIGHT);
    expect(sessionsListMinHeight(null, 12)).toBe(SESSIONS_LIST_MIN_HEIGHT);
    expect(sessionsListMinHeight(Number.NaN, 12, Number.NaN)).toBe(SESSIONS_LIST_MIN_HEIGHT);
    expect(sessionsListMinHeight(0, 12, 0)).toBe(SESSIONS_LIST_MIN_HEIGHT);
    expect(sessionsListMinHeight(150, Number.NaN, 61)).toBe(SESSIONS_LIST_MIN_HEIGHT);
  });

  it('prefers the measured span to the third row (group headers included)', () => {
    expect(sessionsListMinHeight(122, 12)).toBe(134);
    expect(sessionsListMinHeight(122.4, 12)).toBe(134);
  });

  it('estimates three uniform rows plus the padding when fewer than three render', () => {
    expect(sessionsListMinHeight(null, 12, 32)).toBe(108);
    expect(sessionsListMinHeight(null, 12, 61)).toBe(195);
    expect(sessionsListMinHeight(null, 0, 61)).toBe(183);
    expect(sessionsListMinHeight(null, 16, 50)).toBe(166);
  });

  it('feeds the budget cap: the list keeps its measured rows on short windows', () => {
    expect(pinnedRowsMaxHeight(1000, 400, undefined, 195)).toBe(205);
    expect(pinnedRowsMaxHeight(480, 210, 122, 195)).toBe(122);
  });
});

describe('pinnedRowsResizeCeiling', () => {
  it('falls back to the layout cap before the content is measured', () => {
    expect(pinnedRowsResizeCeiling(461, null)).toBe(461);
    expect(pinnedRowsResizeCeiling(461, undefined)).toBe(461);
    expect(pinnedRowsResizeCeiling(461, Number.NaN)).toBe(461);
  });

  it('lets the layout cap bind while the content outgrows it', () => {
    expect(pinnedRowsResizeCeiling(461, 800)).toBe(461);
  });

  it('narrows the ceiling to the content height so the separator tracks visually', () => {
    expect(pinnedRowsResizeCeiling(461, 205)).toBe(205);
    expect(pinnedRowsResizeCeiling(461, 205.4)).toBe(205);
  });

  it('never inverts the bounds, even on degenerate content heights', () => {
    expect(pinnedRowsResizeCeiling(461, 40)).toBe(PINNED_ROWS_MIN_HEIGHT);
  });

  it('floors at the DYNAMIC min height when one is in effect', () => {
    expect(pinnedRowsResizeCeiling(461, 110, 122)).toBe(122);
    expect(pinnedRowsResizeCeiling(461, 110, null)).toBe(110);
    expect(pinnedRowsResizeCeiling(461, 40, null)).toBe(PINNED_ROWS_MIN_HEIGHT);
  });
});

describe('pinnedRowsMinHeight', () => {
  it('falls back to the default-scale floor before a row is measured', () => {
    expect(pinnedRowsMinHeight()).toBe(PINNED_ROWS_MIN_HEIGHT);
    expect(pinnedRowsMinHeight(null)).toBe(PINNED_ROWS_MIN_HEIGHT);
    expect(pinnedRowsMinHeight([])).toBe(PINNED_ROWS_MIN_HEIGHT);
    expect(pinnedRowsMinHeight([Number.NaN])).toBe(PINNED_ROWS_MIN_HEIGHT);
    expect(pinnedRowsMinHeight([0, -30])).toBe(PINNED_ROWS_MIN_HEIGHT);
  });

  it('sums the first two rendered rows (the second can be taller)', () => {
    expect(pinnedRowsMinHeight([50, 50])).toBe(100);
    expect(pinnedRowsMinHeight([50, 61])).toBe(111);
    expect(pinnedRowsMinHeight([49.6, 50.4])).toBe(100);
    expect(pinnedRowsMinHeight([50])).toBe(50);
    expect(pinnedRowsMinHeight([null, 55])).toBe(55);
  });
});

describe('pinnedRowsKeyboardTarget', () => {
  it('steps within the bounds', () => {
    expect(pinnedRowsKeyboardTarget(150, 16, 205, 100)).toBe(166);
    expect(pinnedRowsKeyboardTarget(150, -16, 205, 100)).toBe(134);
  });

  it('clamps to both bounds BEFORE the no-op comparison', () => {
    expect(pinnedRowsKeyboardTarget(100, -16, 205, 100)).toBe(100);
    expect(pinnedRowsKeyboardTarget(205, 16, 205, 100)).toBe(205);
    expect(pinnedRowsKeyboardTarget(122, -48, 205, 122)).toBe(122);
  });
});

describe('measureSessionsListRows', () => {
  const row = (top: number, height: number, listTop = 100) => ({
    visible: true,
    height,
    viewportBottom: listTop + top + height,
  });
  const collapsedRow = { visible: false, height: 0, viewportBottom: 0 };

  it('skips rows hidden inside collapsed groups when picking the first/third row', () => {
    const rows = [collapsedRow, collapsedRow, row(0, 32), row(32, 32), row(90, 32)];
    expect(measureSessionsListRows(rows, 100, 0)).toEqual({ firstRowHeight: 32, spanToThirdRow: 122 });
  });

  it('keeps the span invariant to the list scroll position', () => {
    const rows = [row(0, 32), row(32, 32), row(64, 32)];
    const unscrolled = measureSessionsListRows(rows, 100, 0);
    expect(unscrolled.spanToThirdRow).toBe(96);
    const scrolled = measureSessionsListRows(
      rows.map((r) => ({ ...r, viewportBottom: r.viewportBottom - 70 })),
      100,
      70,
    );
    expect(scrolled.spanToThirdRow).toBe(unscrolled.spanToThirdRow);
    expect(scrolled.firstRowHeight).toBe(unscrolled.firstRowHeight);
  });

  it('returns a null span with fewer than three visible rows, so the keep falls back to the estimate', () => {
    const measured = measureSessionsListRows([row(0, 61), row(61, 61)], 100, 0);
    expect(measured.firstRowHeight).toBe(61);
    expect(measured.spanToThirdRow).toBeNull();
    expect(sessionsListMinHeight(measured.spanToThirdRow, 12, measured.firstRowHeight)).toBe(195);
  });

  it('reports nulls when nothing visible renders (the caller keeps its last good measurement)', () => {
    expect(measureSessionsListRows([], 100, 0)).toEqual({ firstRowHeight: null, spanToThirdRow: null });
    expect(measureSessionsListRows([collapsedRow], 100, 0)).toEqual({
      firstRowHeight: null,
      spanToThirdRow: null,
    });
  });
});

describe('isNoopGesture', () => {
  it('treats a click (no live frame) as a no-op', () => {
    expect(isNoopGesture(205, null)).toBe(true);
  });

  it('treats a drag landing back on the start as a no-op', () => {
    expect(isNoopGesture(205, 205)).toBe(true);
  });

  it('treats a real displacement as an adjustment', () => {
    expect(isNoopGesture(205, 150)).toBe(false);
    expect(isNoopGesture(null, 150)).toBe(false);
  });
});
