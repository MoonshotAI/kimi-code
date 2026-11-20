// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isScrollbarPointer, isUnexpectedScroll, readScrollIntent } from '../../src/lib/transcriptScroll';

function scroller(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperties(el, {
    offsetWidth: { value: 810 },
    clientWidth: { value: 800 },
    getBoundingClientRect: { value: () => ({ top: 0, bottom: 400, left: 0, right: 810, width: 810, height: 400 }) },
  });
  document.body.replaceChildren(el);
  return el;
}

function dispatchAndRead(target: EventTarget, event: Event, pane: HTMLElement) {
  let intent: ReturnType<typeof readScrollIntent> = null;
  pane.addEventListener(event.type, e => {
    intent = readScrollIntent(e, pane);
  }, { once: true });
  target.dispatchEvent(event);
  return intent;
}

function pointer(type: string, init: MouseEventInit, pointerType = 'mouse'): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, ...init });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

describe('readScrollIntent', () => {
  it('reads wheel direction and ignores zoom, horizontal and empty wheels', () => {
    const pane = scroller();
    expect(readScrollIntent(new WheelEvent('wheel', { deltaY: -20 }), pane)).toEqual({ kind: 'scroll', source: 'wheel', direction: -1 });
    expect(readScrollIntent(new WheelEvent('wheel', { deltaY: 20 }), pane)).toEqual({ kind: 'scroll', source: 'wheel', direction: 1 });
    expect(readScrollIntent(new WheelEvent('wheel', { deltaY: -20, ctrlKey: true }), pane)).toBeNull();
    expect(readScrollIntent(new WheelEvent('wheel', { deltaY: -20, shiftKey: true }), pane)).toBeNull();
    expect(readScrollIntent(new WheelEvent('wheel', { deltaX: 20 }), pane)).toBeNull();
  });

  it('ignores upward wheels a nested scroller consumes', () => {
    const pane = scroller();
    const nested = document.createElement('pre');
    Object.defineProperties(nested, { scrollHeight: { value: 500 }, clientHeight: { value: 100 }, scrollTop: { value: 40 } });
    pane.append(nested);
    expect(dispatchAndRead(nested, new WheelEvent('wheel', { deltaY: -20, bubbles: true }), pane)).toBeNull();
    expect(dispatchAndRead(nested, new WheelEvent('wheel', { deltaY: 20, bubbles: true }), pane)).toMatchObject({ direction: 1 });
  });

  it('reads scroll keys outside editable targets', () => {
    const pane = scroller();
    expect(readScrollIntent(new KeyboardEvent('keydown', { key: 'PageUp' }), pane)).toEqual({ kind: 'scroll', source: 'key', direction: -1 });
    expect(readScrollIntent(new KeyboardEvent('keydown', { key: 'End' }), pane)).toEqual({ kind: 'scroll', source: 'key', direction: 1 });
    expect(readScrollIntent(new KeyboardEvent('keydown', { key: 'a' }), pane)).toBeNull();
    const input = document.createElement('textarea');
    pane.append(input);
    expect(dispatchAndRead(input, new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }), pane)).toBeNull();
  });

  it('starts a drag only for a primary non-touch press on the scrollbar gutter', () => {
    const pane = scroller();
    expect(dispatchAndRead(pane, pointer('pointerdown', { clientX: 805 }), pane)).toEqual({ kind: 'drag-start' });
    expect(dispatchAndRead(pane, pointer('pointerdown', { clientX: 400 }), pane)).toBeNull();
    expect(dispatchAndRead(pane, pointer('pointerdown', { clientX: 805, button: 2 }), pane)).toBeNull();
    expect(dispatchAndRead(pane, pointer('pointerdown', { clientX: 805 }, 'touch'), pane)).toBeNull();
    const child = document.createElement('div');
    pane.append(child);
    expect(dispatchAndRead(child, pointer('pointerdown', { clientX: 805 }), pane)).toBeNull();
    expect(readScrollIntent(pointer('pointerup', {}), pane)).toEqual({ kind: 'drag-end' });
  });

  it('maps touch and scrollend events', () => {
    const pane = scroller();
    expect(readScrollIntent(new Event('touchstart'), pane)).toEqual({ kind: 'touch-start' });
    expect(readScrollIntent(new Event('touchmove'), pane)).toEqual({ kind: 'scroll', source: 'touch', direction: 0 });
    expect(readScrollIntent(new Event('touchend'), pane)).toEqual({ kind: 'touch-end' });
    expect(readScrollIntent(new Event('scrollend'), pane)).toEqual({ kind: 'scroll-end' });
    expect(readScrollIntent(new Event('click'), pane)).toBeNull();
  });
});

describe('isScrollbarPointer', () => {
  it('uses a fallback hit width for overlay scrollbars', () => {
    const pane = document.createElement('div');
    Object.defineProperties(pane, {
      offsetWidth: { value: 800 },
      clientWidth: { value: 800 },
      getBoundingClientRect: { value: () => ({ right: 800 }) },
    });
    const event = pointer('pointerdown', { clientX: 790 });
    Object.defineProperty(event, 'target', { value: pane });
    expect(isScrollbarPointer(event as PointerEvent, pane)).toBe(true);
  });
});

describe('isUnexpectedScroll', () => {
  it('tolerates one pixel of rounding', () => {
    expect(isUnexpectedScroll(100.8, 100)).toBe(false);
    expect(isUnexpectedScroll(101.5, 100)).toBe(true);
    expect(isUnexpectedScroll(98, 100)).toBe(true);
  });
});
