import { describe, expect, it, vi } from 'vitest';

async function loadTracker(): Promise<{
  fire: (x: number, y: number) => void;
  fireBlur: () => void;
  fireLeave: () => void;
  isSynthetic: (x: number, y: number) => boolean;
  position: () => { x: number; y: number };
}> {
  vi.resetModules();
  let moveHandler: ((event: { clientX: number; clientY: number }) => void) | undefined;
  let blurHandler: (() => void) | undefined;
  let leaveHandler: (() => void) | undefined;
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'blur') blurHandler = fn;
    },
  };
  (globalThis as Record<string, unknown>).document = {
    addEventListener: (type: string, fn: typeof moveHandler) => {
      if (type === 'pointermove') moveHandler = fn;
    },
    documentElement: {
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'pointerleave') leaveHandler = fn;
      },
    },
  };
  const mod = await import('./pointerMovement');
  mod.ensurePointerTracking();
  return {
    fire: (x, y) => moveHandler?.({ clientX: x, clientY: y }),
    fireBlur: () => blurHandler?.(),
    fireLeave: () => leaveHandler?.(),
    isSynthetic: (x, y) => mod.isSyntheticPointerMove({ clientX: x, clientY: y } as unknown as PointerEvent),
    position: () => mod.lastPointerPosition(),
  };
}

describe('pointerMovement tracker', () => {
  it('treats the first sample as baseline only — cold-start replays never pass', async () => {
    const { fire, isSynthetic } = await loadTracker();
    fire(100, 100);
    expect(isSynthetic(200, 200)).toBe(true);
    expect(isSynthetic(100, 100)).toBe(true);
  });

  it('arms after a coordinate change, then only coordinate replays are synthetic', async () => {
    const { fire, isSynthetic } = await loadTracker();
    fire(100, 100);
    fire(120, 100);
    expect(isSynthetic(200, 200)).toBe(false);
    expect(isSynthetic(100, 100)).toBe(true);
  });

  it('keeps filtering same-coordinate repeats once armed', async () => {
    const { fire, isSynthetic } = await loadTracker();
    fire(100, 100);
    fire(120, 100);
    fire(120, 100);
    expect(isSynthetic(120, 100)).toBe(true);
  });

  it('re-disarms on window blur so post-activation events need a fresh baseline', async () => {
    const { fire, fireBlur, isSynthetic } = await loadTracker();
    fire(100, 100);
    fire(120, 100);
    fireBlur();
    expect(isSynthetic(200, 200)).toBe(true);
    fire(200, 200);
    fire(220, 200);
    expect(isSynthetic(240, 200)).toBe(false);
  });

  it('re-disarms on document pointerleave so re-entry needs a fresh baseline', async () => {
    const { fire, fireLeave, isSynthetic } = await loadTracker();
    fire(100, 100);
    fire(120, 100);
    fireLeave();
    expect(isSynthetic(200, 200)).toBe(true);
    fire(200, 200);
    fire(220, 200);
    expect(isSynthetic(240, 200)).toBe(false);
  });

  it('lastPointerPosition tracks the latest move and resets on invalidation', async () => {
    const { fire, fireBlur, fireLeave, position } = await loadTracker();
    expect(position()).toEqual({ x: -1, y: -1 });
    fire(100, 100);
    fire(120, 100);
    expect(position()).toEqual({ x: 120, y: 100 });
    fireBlur();
    expect(position()).toEqual({ x: -1, y: -1 });
    fire(200, 200);
    expect(position()).toEqual({ x: 200, y: 200 });
    fireLeave();
    expect(position()).toEqual({ x: -1, y: -1 });
  });
});
