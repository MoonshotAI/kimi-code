import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JUMP_PILL_HIDE_DISTANCE,
  nestedScrollerTakesUpwardScroll,
  nextJumpPillVisible,
  scrollKeyDirection,
} from '../src/lib/followScroll';

describe('nextJumpPillVisible', () => {
  it('stays hidden while the bottom is less than half a viewport away', () => {
    expect(nextJumpPillVisible(false, 1, 800)).toBe(false);
    expect(nextJumpPillVisible(false, 40, 800)).toBe(false);
    expect(nextJumpPillVisible(false, 400, 800)).toBe(false);
  });

  it('appears once the bottom is more than half a viewport away', () => {
    expect(nextJumpPillVisible(false, 401, 800)).toBe(true);
    expect(nextJumpPillVisible(true, 2000, 800)).toBe(true);
  });

  it('keeps its state between the hide distance and half a viewport', () => {
    expect(nextJumpPillVisible(true, 200, 800)).toBe(true);
    expect(nextJumpPillVisible(false, 200, 800)).toBe(false);
  });

  it('hides within the hide distance of the bottom', () => {
    expect(JUMP_PILL_HIDE_DISTANCE).toBe(80);
    expect(nextJumpPillVisible(true, 80, 800)).toBe(false);
    expect(nextJumpPillVisible(true, 0, 800)).toBe(false);
  });

  it('uses half the viewport even when the viewport is short', () => {
    expect(nextJumpPillVisible(false, 61, 120)).toBe(true);
    expect(nextJumpPillVisible(true, 50, 120)).toBe(false);
  });
});

describe('scrollKeyDirection', () => {
  const key = (value: string, shiftKey = false) => ({ key: value, shiftKey });

  it('reads PageUp, ArrowUp, Home and Shift+Space as scrolling up', () => {
    expect(scrollKeyDirection(key('PageUp'))).toBe(-1);
    expect(scrollKeyDirection(key('ArrowUp'))).toBe(-1);
    expect(scrollKeyDirection(key('Home'))).toBe(-1);
    expect(scrollKeyDirection(key(' ', true))).toBe(-1);
  });

  it('reads PageDown, ArrowDown, End and Space as scrolling down', () => {
    expect(scrollKeyDirection(key('PageDown'))).toBe(1);
    expect(scrollKeyDirection(key('ArrowDown'))).toBe(1);
    expect(scrollKeyDirection(key('End'))).toBe(1);
    expect(scrollKeyDirection(key(' '))).toBe(1);
  });

  it('ignores keys that do not scroll', () => {
    expect(scrollKeyDirection(key('a'))).toBe(0);
    expect(scrollKeyDirection(key('Enter'))).toBe(0);
    expect(scrollKeyDirection(key('ArrowLeft'))).toBe(0);
  });
});

describe('nestedScrollerTakesUpwardScroll', () => {
  class FakeElement {
    constructor(
      readonly scrollHeight: number,
      readonly clientHeight: number,
      readonly scrollTop: number,
      readonly overflowY = 'visible',
      readonly overscrollBehaviorY = 'auto',
    ) {}
  }

  const stubDom = () => {
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('getComputedStyle', (element: FakeElement) => ({
      overflowY: element.overflowY,
      overscrollBehaviorY: element.overscrollBehaviorY,
    }));
  };

  afterEach(() => vi.unstubAllGlobals());

  it('lets the scroll reach the pane when nothing on the path scrolls', () => {
    stubDom();
    const pane = new FakeElement(4000, 800, 3200, 'auto');
    const text = new FakeElement(20, 20, 0);
    expect(nestedScrollerTakesUpwardScroll([text, pane], pane)).toBe(false);
  });

  it('keeps the scroll in a nested scroller that can still move up', () => {
    stubDom();
    const pane = new FakeElement(4000, 800, 3200, 'auto');
    const output = new FakeElement(900, 260, 120, 'auto');
    expect(nestedScrollerTakesUpwardScroll([output, pane], pane)).toBe(true);
  });

  it('lets the scroll chain to the pane from a nested scroller at its top', () => {
    stubDom();
    const pane = new FakeElement(4000, 800, 3200, 'auto');
    const output = new FakeElement(900, 260, 0, 'auto');
    expect(nestedScrollerTakesUpwardScroll([output, pane], pane)).toBe(false);
  });

  it('keeps the scroll in a nested scroller at its top that contains overscroll', () => {
    stubDom();
    const pane = new FakeElement(4000, 800, 3200, 'auto');
    const contained = new FakeElement(900, 260, 0, 'auto', 'contain');
    const blocked = new FakeElement(900, 260, 0, 'scroll', 'none');
    expect(nestedScrollerTakesUpwardScroll([contained, pane], pane)).toBe(true);
    expect(nestedScrollerTakesUpwardScroll([blocked, pane], pane)).toBe(true);
  });

  it('ignores contained elements that do not scroll vertically', () => {
    stubDom();
    const pane = new FakeElement(4000, 800, 3200, 'auto');
    const short = new FakeElement(200, 200, 0, 'auto', 'contain');
    const clipped = new FakeElement(900, 260, 0, 'hidden', 'contain');
    expect(nestedScrollerTakesUpwardScroll([short, clipped, pane], pane)).toBe(false);
  });

  it('stops looking at the pane', () => {
    stubDom();
    const pane = new FakeElement(4000, 800, 3200, 'auto');
    const outer = new FakeElement(900, 260, 120, 'auto');
    expect(nestedScrollerTakesUpwardScroll([pane, outer], pane)).toBe(false);
  });

  it('never claims the scroll without a DOM', () => {
    const pane = {} as EventTarget;
    expect(nestedScrollerTakesUpwardScroll([{} as EventTarget, pane], pane)).toBe(false);
  });
});
