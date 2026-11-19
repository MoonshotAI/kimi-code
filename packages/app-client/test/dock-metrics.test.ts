import { describe, expect, it } from 'vitest';
import { createDockMetricsPublisher } from '../src/lib/dockMetrics';

describe('createDockMetricsPublisher', () => {
  it('publishes the dock height only when it changes', () => {
    const heights: number[] = [];
    const publish = createDockMetricsPublisher({ setDockHeight: (px) => heights.push(px) });
    publish({ offsetHeight: 80 });
    publish({ offsetHeight: 80 });
    publish({ offsetHeight: 96 });
    expect(heights).toEqual([80, 96]);
  });

  it('treats a missing dock element as zero height', () => {
    const heights: number[] = [];
    const publish = createDockMetricsPublisher({ setDockHeight: (px) => heights.push(px) });
    publish(null);
    expect(heights).toEqual([0]);
  });
});
