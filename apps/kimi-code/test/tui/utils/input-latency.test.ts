import { describe, expect, test } from 'vitest';
import { LatencyStats } from '#/tui/utils/input-latency';

describe('LatencyStats (input→render probe)', () => {
  test('empty stats render the hint line', () => {
    expect(new LatencyStats().formatLines()).toEqual([' input→render: (type something) ']);
  });

  test('records counters, percentiles, max and the worst-five window', () => {
    const s = new LatencyStats();
    for (const v of [5, 12, 8, 150, 400, 30, 1200, 60, 22, 95]) s.record(v, 't');
    expect(s.events).toBe(10);
    expect(s.last).toBe(95);
    expect(s.over100).toBe(3); // 150, 400, 1200
    expect(s.over300).toBe(2); // 400, 1200
    expect(s.over1000).toBe(1); // 1200
    expect(s.max()).toBe(1200);
    expect(s.percentile(50)).toBe(30); // sorted: 5 8 12 22 [30] 60 95 150 400 1200
    expect(s.worst.map((w) => w.latency)).toEqual([1200, 400, 150, 95, 60]);
  });

  test('rolling window drops old samples', () => {
    const s = new LatencyStats();
    for (let i = 0; i < 600; i++) s.record(1, 't');
    s.record(999, 't');
    expect(s.events).toBe(601);
    expect(s.max()).toBe(999); // the window still holds the latest 500
    expect(s.percentile(99)).toBe(1); // 499 ones + one 999: p99 sits on the ones
  });
});
