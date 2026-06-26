import type { Component } from '@earendil-works/pi-tui';
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

  it('returns an empty placeholder when gutters consume the whole width', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(5, 5);
    c.addChild(new FakeChild(seenWidth));
    expect(c.render(2)).toEqual(['']);
    expect(seenWidth).not.toHaveBeenCalled();
  });

  it('keeps emitted lines within the requested width when gutters fit exactly', () => {
    const c = new GutterContainer(3, 2);
    c.addChild(new FakeChild((w) => ['a'.repeat(w)]));
    const lines = c.render(6);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('   a');
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
});
