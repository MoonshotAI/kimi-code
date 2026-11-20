import { describe, expect, it } from 'vitest';
import { HistoryHeights } from '../../src/lib/transcriptScroll';

describe('HistoryHeights', () => {
  it('handles an empty list', () => {
    const heights = new HistoryHeights();
    heights.reset([]);
    expect(heights.length).toBe(0);
    expect(heights.top(0)).toBe(0);
    expect(heights.at(0)).toBe(0);
    expect(heights.at(500)).toBe(0);
  });

  it('handles a single row', () => {
    const heights = new HistoryHeights();
    heights.reset([120]);
    expect(heights.top(1)).toBe(120);
    expect(heights.at(0)).toBe(0);
    expect(heights.at(119)).toBe(0);
    expect(heights.at(1000)).toBe(0);
  });

  it('answers prefix sums and offset lookups at row boundaries', () => {
    const heights = new HistoryHeights();
    heights.reset([10, 20, 30, 40, 50]);
    expect([0, 1, 2, 3, 4, 5].map(i => heights.top(i))).toEqual([0, 10, 30, 60, 100, 150]);
    expect(heights.at(0)).toBe(0);
    expect(heights.at(9.5)).toBe(0);
    expect(heights.at(10)).toBe(1);
    expect(heights.at(29)).toBe(1);
    expect(heights.at(30)).toBe(2);
    expect(heights.at(149)).toBe(4);
    expect(heights.at(150)).toBe(4);
    expect(heights.at(-5)).toBe(0);
  });

  it('updates later offsets when a row changes', () => {
    const heights = new HistoryHeights();
    heights.reset([10, 20, 30]);
    heights.set(1, 50);
    expect(heights.get(1)).toBe(50);
    expect(heights.top(2)).toBe(60);
    expect(heights.top(3)).toBe(90);
    expect(heights.at(59)).toBe(1);
    expect(heights.at(60)).toBe(2);
  });

  it('rebuilds after rows are inserted or removed', () => {
    const heights = new HistoryHeights();
    heights.reset([10, 20, 30]);
    heights.reset([5, 10, 20, 30]);
    expect(heights.top(4)).toBe(65);
    expect(heights.at(5)).toBe(1);
    heights.reset([10, 30]);
    expect(heights.length).toBe(2);
    expect(heights.top(2)).toBe(40);
    expect(heights.at(10)).toBe(1);
  });
});
