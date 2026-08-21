import { describe, expect, it } from 'vitest';
import { resolveSubmenuPlacement } from '../src/lib/submenuPlacement';

// The component passes its positioning constants through; tests pin them.
const GAP = 4;
const MARGIN = 8;

function place(naturalWidth: number, parent: { left: number; right: number }, viewportWidth: number) {
  return resolveSubmenuPlacement(naturalWidth, parent, viewportWidth, GAP, MARGIN);
}

describe('resolveSubmenuPlacement', () => {
  it('opens on the parent right edge when the content fits there', () => {
    expect(place(200, { left: 8, right: 248 }, 1000)).toEqual({ left: 252, maxWidth: 200, flipped: false });
  });

  it('stays right (truncated) when the right overflows but the left is no roomier', () => {
    // Review case: a wide parent hugging the left screen edge leaves a tiny
    // leftRoom, so flipping must not happen — otherwise the panel gets pinned
    // to the viewport margin and sprawls back across the parent menu.
    const p = place(600, { left: 8, right: 308 }, 500);
    expect(p).toEqual({ left: 312, maxWidth: 180, flipped: false });
    expect(p.left + p.maxWidth).toBeLessThanOrEqual(500 - MARGIN);
  });

  it('flips left when the right overflows and the left is roomier', () => {
    const p = place(300, { left: 600, right: 840 }, 1000);
    expect(p).toEqual({ left: 296, maxWidth: 300, flipped: true });
    // The flipped panel's right edge hugs the parent's left edge.
    expect(p.left + p.maxWidth).toBe(600 - GAP);
  });

  it('pins an oversized flipped panel to the viewport margin, capped at the left room', () => {
    const p = place(700, { left: 600, right: 840 }, 1000);
    expect(p).toEqual({ left: MARGIN, maxWidth: 588, flipped: true });
    expect(p.left + p.maxWidth).toBe(600 - GAP);
  });

  it('never overlaps the parent menu across a geometry sweep', () => {
    for (const vw of [400, 800, 1200]) {
      for (const pl of [8, 200, vw - 260]) {
        for (const w of [100, 300, 900]) {
          const p = place(w, { left: pl, right: pl + 240 }, vw);
          if (p.flipped) {
            expect(p.left + p.maxWidth).toBeLessThanOrEqual(pl - GAP);
            expect(p.left).toBeGreaterThanOrEqual(MARGIN);
          } else {
            expect(p.left).toBe(pl + 240 + GAP);
            expect(p.left + p.maxWidth).toBeLessThanOrEqual(vw - MARGIN);
          }
        }
      }
    }
  });
});
