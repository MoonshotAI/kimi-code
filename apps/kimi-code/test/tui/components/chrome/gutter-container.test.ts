import type { Component, TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';

class FakeChild implements Component {
  constructor(
    private readonly lines: (innerWidth: number) => string[],
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.lines(width);
  }
}

class MouseChild extends FakeChild {
  readonly events: TuiMouseEvent[] = [];
  handleMouse(event: TuiMouseEvent) {
    this.events.push(event);
    return { handled: true as const };
  }
}

function clickAt(x: number, y: number, width: number, height: number): TuiMouseEvent {
  return {
    type: 'click',
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
}

describe('GutterContainer', () => {
  it('prefixes every child line with `left` spaces', () => {
    const c = new GutterContainer(2, 2);
    c.addChild(new FakeChild(() => ['hello', 'world']));
    expect(c.render(20)).toEqual(['  hello', '  world']);
  });

  it('shrinks the width passed to children by left + right', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(2, 3);
    c.addChild(new FakeChild(seenWidth));
    c.render(20);
    expect(seenWidth).toHaveBeenCalledWith(15);
  });

  it('clamps inner width to at least 1 when gutters would otherwise consume it', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(5, 5);
    c.addChild(new FakeChild(seenWidth));
    c.render(2);
    expect(seenWidth).toHaveBeenCalledWith(1);
  });

  it('stacks lines from multiple children in order', () => {
    const c = new GutterContainer(1, 0);
    c.addChild(new FakeChild(() => ['a1', 'a2']));
    c.addChild(new FakeChild(() => ['b1']));
    expect(c.render(10)).toEqual([' a1', ' a2', ' b1']);
  });

  it('returns an empty array when there are no children', () => {
    const c = new GutterContainer(2, 2);
    expect(c.render(20)).toEqual([]);
  });

  it('preserves ANSI sequences within child lines (only the leading pad is plain)', () => {
    const colored = '[31mred[0m';
    const c = new GutterContainer(2, 2);
    c.addChild(new FakeChild(() => [colored]));
    expect(c.render(20)).toEqual([`  ${colored}`]);
  });

  it('keeps a leading OSC 133 zone marker at byte 0, before the gutter', () => {
    const c = new GutterContainer(2, 2);
    const marked = `\x1B]133;A\x07content`;
    const doubleMarked = `\x1B]133;B\x07\x1B]133;C\x07last`;
    c.addChild(new FakeChild(() => [marked, doubleMarked]));
    expect(c.render(20)).toEqual([
      `\x1B]133;A\x07  content`,
      `\x1B]133;B\x07\x1B]133;C\x07  last`,
    ]);
  });

  it('translates mouse events into the inner coordinate frame', () => {
    const child = new MouseChild(() => ['x']);
    const c = new GutterContainer(2, 3);
    c.addChild(child);

    c.handleMouse(clickAt(5, 0, 20, 1));
    expect(child.events).toHaveLength(1);
    expect(child.events[0]).toMatchObject({ x: 3, width: 15 });
  });

  it('measures child heights at the inner width when hit-testing', () => {
    const first = new MouseChild((w) => (w >= 19 ? ['a'] : ['a', 'a']));
    const second = new MouseChild(() => ['b']);
    const c = new GutterContainer(1, 1);
    c.addChild(first);
    c.addChild(second);

    // Inner width is 17, where the first child wraps to two rows.
    c.handleMouse(clickAt(3, 1, 19, 3));
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ y: 1 });
    expect(second.events).toHaveLength(0);
  });
});
