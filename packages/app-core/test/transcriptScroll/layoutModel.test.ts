import { describe, expect, it } from 'vitest';
import { LayoutModel, RowHeightCache } from '../../src/lib/transcriptScroll';

function model(options: { scope?: string; cache?: RowHeightCache } = {}) {
  return new LayoutModel({ scope: options.scope ?? 's', cache: options.cache ?? new RowHeightCache(), environment: { width: 800, fontScale: 'medium' } });
}

describe('LayoutModel measurements', () => {
  it('treats a measurement equal to the estimate as measured', () => {
    const m = model();
    m.setRows([{ key: 'a', estimate: 100 }]);
    expect(m.isMeasured('a')).toBe(false);
    m.measure('a', 100);
    expect(m.isMeasured('a')).toBe(true);
    expect(m.record('a')?.measured?.height).toBe(100);
  });

  it('keeps stale measurements as estimates after width, font scale or revision changes', () => {
    const m = model();
    m.setRows([{ key: 'a', estimate: 100, rev: 1 }, { key: 'b', estimate: 100 }]);
    m.measure('a', 240);
    expect(m.total()).toBe(340);

    m.setEnvironment({ width: 600 });
    expect(m.isMeasured('a')).toBe(false);
    expect(m.height(0)).toBe(240);
    m.measure('a', 300);
    expect(m.isMeasured('a')).toBe(true);

    m.setEnvironment({ fontScale: 'large' });
    expect(m.isMeasured('a')).toBe(false);
    expect(m.height(0)).toBe(300);
    m.measure('a', 320);

    m.setRows([{ key: 'a', estimate: 100, rev: 2 }, { key: 'b', estimate: 100 }]);
    expect(m.isMeasured('a')).toBe(false);
    expect(m.height(0)).toBe(320);
  });

  it('rounds widths so subpixel changes do not invalidate measurements', () => {
    const m = model();
    m.setRows([{ key: 'a', estimate: 100 }]);
    m.measure('a', 150);
    expect(m.setEnvironment({ width: 800.3 })).toBe(false);
    expect(m.isMeasured('a')).toBe(true);
  });

  it('keeps measurements across row updates and for rows measured before they are listed', () => {
    const m = model();
    m.measure('later', 77);
    m.setRows([{ key: 'a', estimate: 100 }]);
    m.measure('a', 150);
    m.setRows([{ key: 'later', estimate: 100 }, { key: 'a', estimate: 100 }]);
    expect(m.height(0)).toBe(77);
    expect(m.height(1)).toBe(150);
    expect(m.top(1)).toBe(77);
  });
});

describe('LayoutModel cache', () => {
  it('evicts least recently used rows beyond the limit', () => {
    const cache = new RowHeightCache(3);
    const m = model({ cache });
    m.setRows([{ key: 'a', estimate: 10 }, { key: 'b', estimate: 10 }]);
    m.measure('a', 50);
    m.measure('b', 60);
    m.setScope('t');
    m.setRows([{ key: 'c', estimate: 10 }]);
    expect(cache.size).toBe(3);
    m.setRows([{ key: 'c', estimate: 10 }, { key: 'd', estimate: 10 }]);
    expect(cache.size).toBe(3);
    m.setScope('s');
    m.setRows([{ key: 'b', estimate: 10 }, { key: 'a', estimate: 10 }]);
    expect(m.height(0)).toBe(60);
    expect(m.isMeasured('a')).toBe(false);
    expect(m.height(1)).toBe(10);
  });

  it('keeps the same row key separate across scopes', () => {
    const cache = new RowHeightCache();
    const first = model({ scope: 'one', cache });
    const second = model({ scope: 'two', cache });
    first.setRows([{ key: 'turn', estimate: 100 }]);
    second.setRows([{ key: 'turn', estimate: 100 }]);
    first.measure('turn', 400);
    expect(second.isMeasured('turn')).toBe(false);
    expect(second.height(0)).toBe(100);
    const again = model({ scope: 'one', cache });
    again.setRows([{ key: 'turn', estimate: 100 }]);
    expect(again.height(0)).toBe(400);
  });
});

describe('LayoutModel estimates', () => {
  it('learns per-kind ratios at the current width', () => {
    const m = model();
    m.setRows([
      { key: 'u1', kind: 'user', estimate: 100 },
      { key: 'u2', kind: 'user', estimate: 100 },
      { key: 'u3', kind: 'user', estimate: 200 },
      { key: 'a1', kind: 'assistant', estimate: 100 },
    ]);
    m.measure('u1', 150);
    m.measure('u2', 150);
    expect(m.refreshEstimates()).toBe(true);
    expect(m.height(2)).toBe(300);
    expect(m.height(3)).toBe(100);
    expect(m.refreshEstimates()).toBe(false);

    m.setEnvironment({ width: 400 });
    expect(m.height(2)).toBe(200);
    expect(m.height(0)).toBe(150);
  });

  it('prefers a stale measurement over a learned estimate', () => {
    const m = model();
    m.setRows([{ key: 'u1', kind: 'user', estimate: 100 }, { key: 'u2', kind: 'user', estimate: 100 }]);
    m.measure('u1', 500);
    m.setEnvironment({ width: 500 });
    m.measure('u2', 120);
    m.refreshEstimates();
    expect(m.height(0)).toBe(500);
  });

  it('falls back to the caller estimate with a floor', () => {
    const m = model();
    m.setRows([{ key: 'a', estimate: 0 }, { key: 'b', estimate: 42 }]);
    expect(m.height(0)).toBe(1);
    expect(m.height(1)).toBe(42);
  });
});

describe('LayoutModel range', () => {
  function rows(n: number) {
    const m = model();
    m.setRows(Array.from({ length: n }, (_, i) => ({ key: `r${i}`, estimate: 100 })));
    return m;
  }

  function covered(range: ReturnType<LayoutModel['range']>, m: LayoutModel): number {
    return range.rows.reduce((sum, row) => sum + row.spaceBefore + m.height(row.index), 0) + range.spaceAfter;
  }

  it('maps offsets to rows and back', () => {
    const m = rows(10);
    expect(m.total()).toBe(1000);
    expect(m.top(3)).toBe(300);
    expect(m.indexAt(299)).toBe(2);
    expect(m.indexAt(300)).toBe(3);
    expect(m.indexAt(5000)).toBe(9);
  });

  it('renders the viewport plus overscan with spacer heights', () => {
    const m = rows(20);
    const range = m.range(500, 700, { overscanPx: 150 });
    expect(range.rows.map(r => r.index)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(range.rows[0]!.spaceBefore).toBe(300);
    expect(range.rows.slice(1).every(r => r.spaceBefore === 0)).toBe(true);
    expect(range.spaceAfter).toBe(1100);
    expect(covered(range, m)).toBe(m.total());
  });

  it('adds tail and protected rows with their own spacers', () => {
    const m = rows(20);
    const range = m.range(500, 600, { tail: 2, protected: new Set(['r1', 'missing']) });
    expect(range.rows.map(r => r.index)).toEqual([1, 5, 6, 18, 19]);
    expect(range.rows.map(r => r.spaceBefore)).toEqual([100, 300, 0, 1100, 0]);
    expect(range.spaceAfter).toBe(0);
    expect(covered(range, m)).toBe(m.total());
  });

  it('renders every row when requested', () => {
    const m = rows(5);
    expect(m.range(0, 0, { renderAll: true }).rows.map(r => r.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('renders nothing but the tail when the view is outside the list', () => {
    const m = rows(5);
    expect(m.range(900, 1200, { tail: 1 }).rows.map(r => r.index)).toEqual([4]);
    expect(m.range(-500, -100, {}).rows).toEqual([]);
    expect(model().range(0, 100, { tail: 2 })).toEqual({ rows: [], spaceAfter: 0 });
  });
});
