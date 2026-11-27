import { ref, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { overlayScrollbarThumb, useOverlayScrollbar } from '../src/composables/useOverlayScrollbar';

describe('overlayScrollbarThumb', () => {
  it('returns null while the content fits (no scrollable overflow)', () => {
    expect(overlayScrollbarThumb(0, 400, 400, 0, 24)).toBeNull();
    expect(overlayScrollbarThumb(0, 401, 400, 0, 24)).toBeNull();
  });

  it('returns null when the inset eats the whole track', () => {
    expect(overlayScrollbarThumb(0, 800, 40, 20, 24)).toBeNull();
  });

  it('sizes the thumb to the visible fraction', () => {
    expect(overlayScrollbarThumb(0, 800, 400, 0, 24)).toEqual({ top: 0, height: 200 });
  });

  it('moves the thumb proportionally with scrollTop', () => {
    expect(overlayScrollbarThumb(200, 800, 400, 0, 24)).toEqual({ top: 100, height: 200 });
    expect(overlayScrollbarThumb(400, 800, 400, 0, 24)).toEqual({ top: 200, height: 200 });
  });

  it('floors the thumb at thumbMin so it stays grabbable', () => {
    expect(overlayScrollbarThumb(0, 10000, 400, 0, 24)).toEqual({ top: 0, height: 24 });
  });

  it('caps the thumb at the track for degenerate (tiny) scrollers', () => {
    expect(overlayScrollbarThumb(0, 60, 20, 0, 24)).toEqual({ top: 0, height: 20 });
  });

  it('shrinks the track by the inset on both ends', () => {
    expect(overlayScrollbarThumb(0, 800, 400, 8, 24)).toEqual({ top: 8, height: 192 });
    expect(overlayScrollbarThumb(400, 800, 400, 8, 24)).toEqual({ top: 200, height: 192 });
  });
});

function fakeScroller(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  offsetTop?: number;
}): HTMLElement {
  return { offsetTop: 0, ...metrics } as unknown as HTMLElement;
}

describe('useOverlayScrollbar', () => {
  beforeEach(() => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the thumb ref identity stable while the geometry is unchanged', () => {
    const el = fakeScroller({ scrollTop: 0, scrollHeight: 800, clientHeight: 400 });
    const { thumb, update } = useOverlayScrollbar(ref(el));
    update();
    const first = thumb.value;
    expect(first).not.toBeNull();
    update();
    update();
    expect(thumb.value).toBe(first);
  });

  it('replaces the thumb when the geometry changes', () => {
    const el = fakeScroller({ scrollTop: 0, scrollHeight: 800, clientHeight: 400 });
    const { thumb, update } = useOverlayScrollbar(ref(el));
    update();
    const first = thumb.value;
    el.scrollTop = 100;
    update();
    expect(thumb.value).not.toBe(first);
    expect(thumb.value?.top).toBe(50);
  });

  it('is null while the content fits and while the scroller is unmounted', () => {
    const scrollEl: Ref<HTMLElement | null> = ref(null);
    const { thumb, update } = useOverlayScrollbar(scrollEl);
    update();
    expect(thumb.value).toBeNull();
    scrollEl.value = fakeScroller({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 });
    update();
    expect(thumb.value).toBeNull();
  });

  it('anchors the thumb to the scroller’s offsetTop', () => {
    const el = fakeScroller({ scrollTop: 0, scrollHeight: 800, clientHeight: 400, offsetTop: 40 });
    const { thumb, update } = useOverlayScrollbar(ref(el));
    update();
    expect(thumb.value).toEqual({ top: 40, height: 200 });
  });

  it('reveals the thumb on hover and while scrolling, hiding again when idle', () => {
    vi.useFakeTimers();
    try {
      const el = fakeScroller({ scrollTop: 0, scrollHeight: 800, clientHeight: 400 });
      const sb = useOverlayScrollbar(ref(el));
      sb.update();
      expect(sb.thumbVisible.value).toBe(false);
      sb.onListMouseEnter();
      expect(sb.thumbVisible.value).toBe(true);
      sb.onListMouseLeave();
      expect(sb.thumbVisible.value).toBe(false);
      sb.markScrolling();
      expect(sb.thumbVisible.value).toBe(true);
      vi.advanceTimersByTime(950);
      expect(sb.thumbVisible.value).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
