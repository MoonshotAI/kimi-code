import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GutterLayout } from '#/tui/components/chrome/gutter-container';
import * as userMessages from '#/tui/components/messages/user-message';
import { StickyUserMessageIndex } from '#/tui/utils/sticky-user-message';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';

function user(
  content: string,
  height = 2,
  bullet?: string,
  turnId?: string,
): GutterLayout['children'][number] {
  const component = { render: vi.fn(() => []), invalidate() {} };
  markTranscriptComponent(component, {
    id: 'user',
    kind: 'user',
    content,
    renderMode: 'plain',
    bullet,
    turnId,
  });
  return { component, height };
}

function other(height: number): GutterLayout['children'][number] {
  return { component: { render: vi.fn(() => []), invalidate() {} }, height };
}

function layout(children: GutterLayout['children'], contentWidth = 80): GutterLayout {
  return { children, contentWidth };
}

afterEach(() => vi.restoreAllMocks());

describe('StickyUserMessageIndex', () => {
  it('has no candidate for empty content or at the start of a transcript', () => {
    const index = new StickyUserMessageIndex();
    expect(index.getJudgment(layout([]), 10, false)).toBeNull();
    expect(index.getJudgment(layout([user('hello'), other(20)]), 0, false)).toBeNull();
  });

  it('pins only after the actual first line has passed the top row', () => {
    const index = new StickyUserMessageIndex();
    const message = user('hello');
    const body = layout([message, other(20)]);
    expect(index.getJudgment(body, 2, false)).toBeNull();
    expect(index.getJudgment(body, 3, false)).toEqual({
      component: message.component,
      summary: 'hello',
      targetY: 2,
    });
    expect(index.getJudgment(body, 2, false)).toBeNull();
  });

  it('merges logical lines hidden by scrolling or by the pill', () => {
    const index = new StickyUserMessageIndex();
    const body = layout([user('one\ntwo\nthree', 4), other(20)]);
    expect(index.getJudgment(body, 3, false)?.summary).toBe('one two');
    expect(index.getJudgment(body, 4, false)?.summary).toBe('one two three');
    expect(index.getJudgment(body, 50, false)?.summary).toBe('one two three');
  });

  it.each([
    { name: 'missing turn IDs', turnIds: [undefined, undefined, undefined, undefined] },
    { name: 'live turn IDs', turnIds: [undefined, 'turn', 'turn', 'turn'] },
    { name: 'matching turn IDs', turnIds: ['turn', 'turn', 'turn', 'turn'] },
    { name: 'replay turn IDs', turnIds: ['replay:1', 'replay:2', 'replay:3', 'replay:4'] },
  ])('keeps adjacent messages separate with $name', ({ turnIds }) => {
    const index = new StickyUserMessageIndex();
    const latest = user('4\n5\n6', 4, undefined, turnIds[3]);
    const body = layout([
      user('1', 2, undefined, turnIds[0]),
      user('2', 2, undefined, turnIds[1]),
      user('3', 2, undefined, turnIds[2]),
      latest,
      other(20),
    ]);
    expect(index.getJudgment(body, 3, false)?.summary).toBe('1');
    expect(index.getJudgment(body, 5, false)?.summary).toBe('2');
    expect(index.getJudgment(body, 7, false)?.summary).toBe('3');
    expect(index.getJudgment(body, 7, true)).toBeNull();
    expect(index.getJudgment(body, 9, false)?.summary).toBe('4 5');
    expect(index.getJudgment(body, 10, true)).toEqual({
      component: latest.component,
      summary: '4 5 6',
      targetY: 8,
    });
    for (const target of [2, 4, 6, 8]) {
      expect(index.getJudgment(body, target, false)).toBeNull();
    }
  });

  it('refreshes the candidate after replacement, trimming, and appending', () => {
    const index = new StickyUserMessageIndex();
    const first = user('first');
    const second = user('second');
    const third = user('third');
    expect(index.getJudgment(layout([first, second]), 20, false)?.summary).toBe('second');
    expect(index.getJudgment(layout([first, third]), 20, false)?.summary).toBe('third');
    expect(index.getJudgment(layout([first]), 20, false)).toEqual({
      component: first.component,
      summary: 'first',
      targetY: 2,
    });
    expect(index.getJudgment(layout([first, third]), 20, false)).toEqual({
      component: third.component,
      summary: 'third',
      targetY: 4,
    });
  });

  it('counts wrapped visual rows at the actual content width', () => {
    const index = new StickyUserMessageIndex();
    const body = layout([user('abcdefgh\nnext', 4), other(20)], 6);
    expect(index.getJudgment(body, 3, false)?.summary).toBe('abcdefgh');
    expect(index.getJudgment(body, 4, false)?.summary).toBe('abcdefgh next');
  });

  it('accounts for leading blank lines and lands clicks on the original text', () => {
    const index = new StickyUserMessageIndex();
    const body = layout([other(4), user('\n\nfirst\nsecond', 5), other(20)]);
    expect(index.getJudgment(body, 8, false)).toBeNull();
    const judgment = index.getJudgment(body, 10, false);
    expect(judgment?.summary).toBe('first second');
    expect(judgment?.targetY).toBe(8);
    expect(index.getJudgment(body, judgment!.targetY, false)).toBeNull();
  });

  it('hides the previous pill when the next user first line is exactly at the top', () => {
    const index = new StickyUserMessageIndex();
    const body = layout([user('first'), other(8), user('second'), other(20)]);
    expect(index.getJudgment(body, 11, false)?.summary).toBe('first');
    expect(index.getJudgment(body, 12, false)).toBeNull();
    expect(index.getJudgment(body, 13, false)?.summary).toBe('second');
    expect(index.getJudgment(body, 12, false)).toBeNull();
  });

  it('only pins the latest user message when following output', () => {
    const index = new StickyUserMessageIndex();
    const body = layout([user('first'), other(8), user('second'), other(20)]);
    expect(index.getJudgment(body, 10, true)).toBeNull();
    expect(index.getJudgment(body, 10, false)?.summary).toBe('first');
    expect(index.getJudgment(body, 13, true)?.summary).toBe('second');
  });

  it('excludes suppressed bullets, empty text, and non-user entries', () => {
    const index = new StickyUserMessageIndex();
    const body = layout([user('$ echo', 1, ''), user('', 4), user(' \n \n ', 4), other(20)]);
    expect(index.getJudgment(body, 30, false)).toBeNull();
  });

  it('cleans whitespace without retaining leading blank lines', () => {
    const index = new StickyUserMessageIndex();
    const body = layout([user('\n  first   \t second\r\n third  ', 4), other(20)]);
    expect(index.getJudgment(body, 20, false)?.summary).toBe('first second third');
  });

  it('retains positions across zero-height entries and clamps a truncated message offset', () => {
    const index = new StickyUserMessageIndex();
    const body = layout([other(4), other(0), user('\n\nhello', 2), other(20)]);
    expect(index.getJudgment(body, 20, false)?.targetY).toBe(7);
  });

  it('measures only the candidate and reuses it across scrolling and unrelated height changes', () => {
    const measure = vi.spyOn(userMessages, 'userMessageLineHeights');
    const index = new StickyUserMessageIndex();
    const children = Array.from({ length: 500 }, (_, i) =>
      user('message ' + i + '\nmore', 3, undefined, String(i)),
    );
    const body = layout(children);
    const first = index.getJudgment(body, 2000, false);
    expect(first?.summary).toBe('message 499 more');
    expect(measure).toHaveBeenCalledTimes(1);
    for (const scrollTop of [2001, 2002, 2003]) index.getJudgment(body, scrollTop, false);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(
      children.every(({ component }) => vi.mocked(component.render).mock.calls.length === 0),
    ).toBe(true);

    const resizedEntry = layout([{ ...children[0]!, height: 6 }, ...children.slice(1)]);
    expect(index.getJudgment(resizedEntry, 2000, false)?.targetY).toBe(first!.targetY + 3);
    expect(measure).toHaveBeenCalledTimes(1);

    index.getJudgment(layout(resizedEntry.children, 20), 2000, false);
    expect(measure).toHaveBeenCalledTimes(2);
    index.getJudgment(layout([...children.slice(0, -1), user('replacement')], 20), 2000, false);
    expect(measure).toHaveBeenCalledTimes(3);
  });
});
