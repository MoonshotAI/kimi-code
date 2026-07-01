import type { Component } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { TranscriptContainer } from '#/tui/components/chrome/transcript-container';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';

class FakeChild implements Component {
  constructor(private readonly lines: string[]) {}
  invalidate(): void {}
  render(_width: number): string[] {
    return this.lines;
  }
}

let nextBoundaryId = 0;

function turnBoundary(): Component {
  const child = new UserMessageComponent('hello');
  // turnId undefined marks a live user message, which starts a new turn.
  markTranscriptComponent(child, {
    id: `boundary-${nextBoundaryId++}`,
    kind: 'user',
    renderMode: 'markdown',
    content: 'hello',
  });
  return child;
}

describe('TranscriptContainer', () => {
  it('returns undefined when there are no children', () => {
    const c = new TranscriptContainer(2, 2);
    c.render(20);
    expect(c.getNativeScrollbackLiveRegionStart()).toBeUndefined();
  });

  it('returns undefined when no child is a turn boundary', () => {
    const c = new TranscriptContainer(2, 2);
    c.addChild(new FakeChild(['a1', 'a2', 'a3']));
    c.addChild(new FakeChild(['b1']));
    c.render(20);
    expect(c.getNativeScrollbackLiveRegionStart()).toBeUndefined();
  });

  it('returns the start row of the turn-boundary child', () => {
    const c = new TranscriptContainer(2, 2);
    c.addChild(new FakeChild(['a1', 'a2', 'a3'])); // 3 lines -> rows 0..2
    c.addChild(new FakeChild(['b1', 'b2'])); // 2 lines -> rows 3..4
    c.addChild(turnBoundary()); // starts at row 5
    c.render(20);
    expect(c.getNativeScrollbackLiveRegionStart()).toBe(5);
  });

  it('returns the start row of the LAST turn boundary (current turn wins)', () => {
    const c = new TranscriptContainer(2, 2);
    const inner = 20 - 2 - 2;
    const first = turnBoundary(); // starts at row 0
    const firstLines = first.render(inner).length;
    const middle = new FakeChild(['m1', 'm2']); // 2 lines
    const last = turnBoundary(); // starts at row firstLines + 2

    c.addChild(first);
    c.addChild(middle);
    c.addChild(last);
    c.render(20);

    expect(c.getNativeScrollbackLiveRegionStart()).toBe(firstLines + 2);
  });

  it('resets to undefined after a re-render with no boundary', () => {
    const c = new TranscriptContainer(2, 2);
    c.addChild(turnBoundary());
    c.render(20);
    expect(c.getNativeScrollbackLiveRegionStart()).toBeTypeOf('number');

    c.clear();
    c.addChild(new FakeChild(['x1']));
    c.render(20);
    expect(c.getNativeScrollbackLiveRegionStart()).toBeUndefined();
  });
});
