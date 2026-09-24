import { visibleWidth, type TuiMouseEvent, type TuiMouseEventType } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  StickyUserMessageComponent,
  type StickyUserMessageSource,
} from '#/tui/components/messages/sticky-user-message';
import type { StickyJudgmentEntry } from '#/tui/utils/sticky-user-message';

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function user(content: string, height: number, bullet?: string): StickyJudgmentEntry {
  return { kind: 'user', bullet, content, height, lineHeights: content.split('\n').map(() => 1) };
}

function assistant(height: number): StickyJudgmentEntry {
  return { kind: 'assistant', content: '', height, lineHeights: [] };
}

interface FakeSource extends StickyUserMessageSource {
  jumps: number[];
  setScroll(scrollTop: number, following: boolean): void;
}

function fakeSource(entries: StickyJudgmentEntry[], scrollTop = 0, following = false): FakeSource {
  const state = { scrollTop, following };
  const jumps: number[] = [];
  return {
    jumps,
    measure: () => entries,
    scrollState: () => ({ scrollTop: state.scrollTop, following: state.following }),
    scrollTo: (y) => {
      jumps.push(y);
      state.scrollTop = y;
      state.following = false;
    },
    setScroll: (nextScrollTop, nextFollowing) => {
      state.scrollTop = nextScrollTop;
      state.following = nextFollowing;
    },
  };
}

function mouseEvent(type: TuiMouseEventType): TuiMouseEvent {
  return {
    type,
    button: type === 'wheel' ? 'none' : 'left',
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

describe('StickyUserMessageComponent', () => {
  it('renders nothing when nothing is pinned, so the slot takes no row', () => {
    const component = new StickyUserMessageComponent(fakeSource([user('hello', 3), assistant(10)]));
    expect(component.render(80)).toEqual([]);
  });

  it('renders one line with the bullet and the cleaned summary once scrolled past', () => {
    const component = new StickyUserMessageComponent(
      fakeSource([user('fix the flaky test', 3), assistant(10)], 3),
    );
    const lines = component.render(80);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toBe('❯ fix the flaky test');
  });

  it('renders only the first line of a multi-line message while the rest is still visible', () => {
    const component = new StickyUserMessageComponent(
      fakeSource([user('line one\nline   two\n\nsecond paragraph', 6), assistant(10)], 1),
    );
    expect(stripAnsi(component.render(80)[0]!)).toBe('❯ line one');
  });

  it('renders the merged scrolled-out lines as the summary', () => {
    const component = new StickyUserMessageComponent(
      fakeSource(
        [
          { kind: 'user', content: 'one\ntwo\nthree', height: 3, lineHeights: [1, 1, 1] },
          assistant(10),
        ],
        2,
      ),
    );
    expect(stripAnsi(component.render(80)[0]!)).toBe('❯ one two');
  });

  it('truncates the summary to the render width with an ellipsis', () => {
    const longMessage = 'a very long user message that cannot possibly fit in twenty cells';
    const component = new StickyUserMessageComponent(
      fakeSource([user(longMessage, 3), assistant(10)], 3),
    );
    const lines = component.render(20);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(20);
    expect(stripAnsi(lines[0]!).endsWith('…')).toBe(true);
  });

  it('renders a single line however long the summary is', () => {
    const longMessage = 'word '.repeat(200).trim();
    const component = new StickyUserMessageComponent(
      fakeSource([user(longMessage, 3), assistant(10)], 3),
    );
    expect(component.render(40)).toHaveLength(1);
  });

  it('renders the ❯ bullet', () => {
    const component = new StickyUserMessageComponent(
      fakeSource([user('hello', 3), assistant(10)], 3),
    );
    expect(stripAnsi(component.render(80)[0]!)).toBe('❯ hello');
  });

  it('keeps rendered lines within very narrow widths', () => {
    const component = new StickyUserMessageComponent(
      fakeSource([user('please inspect the attached output', 3), assistant(10)], 3),
    );
    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('jumps to one line past the candidate first line on click, keeping the pill pinned', () => {
    const source = fakeSource([assistant(4), user('hello', 2), assistant(10)], 6);
    const component = new StickyUserMessageComponent(source);
    component.render(80);
    expect(component.handleMouse(mouseEvent('click'))).toEqual({ handled: true });
    expect(source.jumps).toEqual([5]);
    expect(stripAnsi(component.render(80)[0]!)).toContain('hello');
  });

  it('jumps past the leading blank lines of the candidate message on click', () => {
    const source = fakeSource(
      [
        assistant(4),
        { kind: 'user', content: 'hello', height: 2, contentOffset: 1, lineHeights: [1] },
        assistant(10),
      ],
      6,
    );
    const component = new StickyUserMessageComponent(source);
    component.render(80);
    expect(component.handleMouse(mouseEvent('click'))).toEqual({ handled: true });
    expect(source.jumps).toEqual([6]);
    expect(stripAnsi(component.render(80)[0]!)).toContain('hello');
  });

  it('releases the pill when the user scrolls the message first line back into view', () => {
    const source = fakeSource([assistant(4), user('hello', 2), assistant(10)], 6);
    const component = new StickyUserMessageComponent(source);
    expect(stripAnsi(component.render(80)[0]!)).toContain('hello');
    source.setScroll(4, false);
    expect(component.render(80)).toEqual([]);
  });

  it('does not consume wheel events so scrolling falls through', () => {
    const source = fakeSource([user('hello', 3), assistant(10)], 3);
    const component = new StickyUserMessageComponent(source);
    component.render(80);
    expect(component.handleMouse(mouseEvent('wheel'))).toBeUndefined();
    expect(source.jumps).toEqual([]);
  });

  it('ignores clicks when nothing is stuck', () => {
    const source = fakeSource([user('hello', 3), assistant(10)]);
    const component = new StickyUserMessageComponent(source);
    component.render(80);
    expect(component.handleMouse(mouseEvent('click'))).toBeUndefined();
    expect(source.jumps).toEqual([]);
  });
});
