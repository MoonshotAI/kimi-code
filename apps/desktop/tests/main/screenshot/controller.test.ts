import { describe, expect, it } from 'vitest';

import { cropRegionPixels, matchFramesToDisplays, type DisplayLike, type FrameSourceLike } from '../../../src/main/screenshot/controller';

function display(id: number, bounds: { x: number; y: number; width: number; height: number }, scaleFactor = 2): DisplayLike {
  return { id, bounds, scaleFactor };
}

function source(displayId: string, width: number, height: number, empty = false): FrameSourceLike {
  return { display_id: displayId, thumbnailSize: { width, height }, thumbnailEmpty: empty };
}

describe('matchFramesToDisplays', () => {
  it('pairs each display with its source by display_id', () => {
    const displays = [display(1, { x: 0, y: 0, width: 1440, height: 900 }), display(2, { x: 1440, y: 0, width: 1920, height: 1080 })];
    const sources = [source('2', 3840, 2160), source('1', 2880, 1800)];
    const { matched, skipped } = matchFramesToDisplays(sources, displays);
    expect(matched.map((m) => m.display.id)).toEqual([1, 2]);
    expect(matched[0]?.source.thumbnailSize.width).toBe(2880);
    expect(skipped).toEqual([]);
  });

  it('skips displays without a matching source (hotplug race)', () => {
    const displays = [display(1, { x: 0, y: 0, width: 1440, height: 900 }), display(3, { x: -1920, y: 0, width: 1920, height: 1080 })];
    const sources = [source('1', 2880, 1800)];
    const { matched, skipped } = matchFramesToDisplays(sources, displays);
    expect(matched.map((m) => m.display.id)).toEqual([1]);
    expect(skipped.map((d) => d.id)).toEqual([3]);
  });

  it('skips displays whose thumbnail is empty (granted but needs restart)', () => {
    const displays = [display(1, { x: 0, y: 0, width: 1440, height: 900 }), display(2, { x: 1440, y: 0, width: 1920, height: 1080 })];
    const sources = [source('1', 2880, 1800, true), source('2', 3840, 2160)];
    const { matched, skipped } = matchFramesToDisplays(sources, displays);
    expect(matched.map((m) => m.display.id)).toEqual([2]);
    expect(skipped.map((d) => d.id)).toEqual([1]);
  });

  it('falls back to the only non-empty source with an empty display_id on a single display', () => {
    const displays = [display(1, { x: 0, y: 0, width: 1920, height: 1080 }, 1)];
    const sources = [source('', 1920, 1080)];
    const { matched, skipped } = matchFramesToDisplays(sources, displays);
    expect(matched).toEqual([{ display: displays[0], source: sources[0] }]);
    expect(skipped).toEqual([]);
  });

  it('does not fall back to an empty thumbnail', () => {
    const displays = [display(1, { x: 0, y: 0, width: 1920, height: 1080 }, 1)];
    const sources = [source('', 0, 0, true)];
    const { matched, skipped } = matchFramesToDisplays(sources, displays);
    expect(matched).toEqual([]);
    expect(skipped).toEqual(displays);
  });

  it('does not fall back when there are multiple displays', () => {
    const displays = [display(1, { x: 0, y: 0, width: 1920, height: 1080 }), display(2, { x: 1920, y: 0, width: 1920, height: 1080 })];
    const sources = [source('', 1920, 1080)];
    const { matched, skipped } = matchFramesToDisplays(sources, displays);
    expect(matched).toEqual([]);
    expect(skipped).toEqual(displays);
  });

  it('does not fall back when a single display has ambiguous sources', () => {
    const displays = [display(1, { x: 0, y: 0, width: 1920, height: 1080 }, 1)];
    const sources = [source('', 1920, 1080), source('', 1920, 1080)];
    const { matched, skipped } = matchFramesToDisplays(sources, displays);
    expect(matched).toEqual([]);
    expect(skipped).toEqual(displays);
  });

  it('does not fall back for a non-empty mismatched display_id', () => {
    const displays = [display(1, { x: 0, y: 0, width: 1920, height: 1080 }, 1)];
    const sources = [source('2', 1920, 1080)];
    const { matched, skipped } = matchFramesToDisplays(sources, displays);
    expect(matched).toEqual([]);
    expect(skipped).toEqual(displays);
  });
});

describe('cropRegionPixels', () => {
  it('converts points to pixels via the per-screen ratio (scaleFactor 2)', () => {
    const d = display(1, { x: 0, y: 0, width: 1440, height: 900 });
    const crop = cropRegionPixels({ x: 100, y: 50, width: 315, height: 313 }, { thumbnailSize: { width: 2880, height: 1800 } }, d);
    expect(crop).toEqual({ x: 200, y: 100, width: 630, height: 626 });
  });

  it('uses the actual thumbnail size, not CSS × scaleFactor, for mixed-DPI screens', () => {
    const d = display(2, { x: 0, y: 0, width: 1920, height: 1080 }, 1.5);
    const crop = cropRegionPixels({ x: 10, y: 20, width: 100, height: 50 }, { thumbnailSize: { width: 2880, height: 1620 } }, d);
    expect(crop).toEqual({ x: 15, y: 30, width: 150, height: 75 });
  });

  it('uses separate horizontal and vertical ratios for non-uniform captures', () => {
    const d = display(2, { x: 0, y: 0, width: 1000, height: 800 }, 1);
    const crop = cropRegionPixels({ x: 10, y: 20, width: 100, height: 50 }, { thumbnailSize: { width: 2000, height: 1200 } }, d);
    expect(crop).toEqual({ x: 20, y: 30, width: 200, height: 75 });
  });

  it('rounds half-pixel edges deterministically', () => {
    const d = display(1, { x: 0, y: 0, width: 1440, height: 900 });
    const crop = cropRegionPixels({ x: 0.25, y: 0.75, width: 1.25, height: 2.25 }, { thumbnailSize: { width: 2880, height: 1800 } }, d);
    expect(crop).toEqual({ x: 1, y: 2, width: 3, height: 5 });
  });

  it('clamps the crop into the thumbnail bounds', () => {
    const d = display(1, { x: 0, y: 0, width: 1440, height: 900 });
    const crop = cropRegionPixels({ x: -20, y: 800, width: 2000, height: 500 }, { thumbnailSize: { width: 2880, height: 1800 } }, d);
    expect(crop).toEqual({ x: 0, y: 1600, width: 2880, height: 200 });
  });

  it('never emits a zero-size crop', () => {
    const d = display(1, { x: 0, y: 0, width: 1440, height: 900 });
    const crop = cropRegionPixels({ x: 1439.9, y: 899.9, width: 0.2, height: 0.2 }, { thumbnailSize: { width: 2880, height: 1800 } }, d);
    expect(crop.width).toBeGreaterThanOrEqual(1);
    expect(crop.height).toBeGreaterThanOrEqual(1);
  });
});
