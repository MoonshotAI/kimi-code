import { describe, expect, it } from 'vitest';

import type { TranscriptEntryKind } from '#/tui/types';
import {
  judgeStickyUserMessage,
  summarizeStickyUserMessage,
  type StickyJudgmentEntry,
} from '#/tui/utils/sticky-user-message';

function user(content: string, height: number, bullet?: string): StickyJudgmentEntry {
  return { kind: 'user', bullet, content, height, lineHeights: content.split('\n').map(() => 1) };
}

function other(kind: TranscriptEntryKind, height: number): StickyJudgmentEntry {
  return { kind, content: '', height, lineHeights: [] };
}

describe('summarizeStickyUserMessage', () => {
  it('collapses every whitespace run within the first line into a single space', () => {
    expect(summarizeStickyUserMessage('first   \t  second')).toBe('first second');
  });

  it('keeps only the first non-empty line', () => {
    expect(summarizeStickyUserMessage('first\nsecond   \t  third')).toBe('first');
    expect(summarizeStickyUserMessage('para one\n\npara two')).toBe('para one');
    expect(summarizeStickyUserMessage('\n\n  \nhello')).toBe('hello');
  });

  it('merges the given number of leading lines into one row', () => {
    expect(summarizeStickyUserMessage('one\ntwo\nthree', 2)).toBe('one two');
    expect(summarizeStickyUserMessage('one\ntwo\nthree', 9)).toBe('one two three');
    expect(summarizeStickyUserMessage('\n\n\none\ntwo', 2)).toBe('one two');
  });

  it('trims surrounding whitespace', () => {
    expect(summarizeStickyUserMessage('  padded  ')).toBe('padded');
  });

  it('returns an empty string for empty or whitespace-only content', () => {
    expect(summarizeStickyUserMessage('')).toBe('');
    expect(summarizeStickyUserMessage('  \n \n ')).toBe('');
  });
});

describe('judgeStickyUserMessage', () => {
  it('returns null when the transcript is empty', () => {
    expect(judgeStickyUserMessage({ entries: [], scrollTop: 10, following: false })).toBeNull();
  });

  it('returns null at the top of the transcript', () => {
    const entries = [user('hello', 3), other('assistant', 10)];
    expect(judgeStickyUserMessage({ entries, scrollTop: 0, following: false })).toBeNull();
  });

  it('pins the user message once its first content line scrolls above the viewport top', () => {
    const entries: StickyJudgmentEntry[] = [
      { kind: 'user', content: 'fix the flaky test', height: 3, contentOffset: 1, lineHeights: [1] },
      other('assistant', 20),
    ];
    expect(judgeStickyUserMessage({ entries, scrollTop: 1, following: false })).toBeNull();
    const judgment = judgeStickyUserMessage({ entries, scrollTop: 2, following: false });
    expect(judgment).toEqual({ index: 0, summary: 'fix the flaky test', targetY: 2 });
  });

  it('pins an offset-less message as soon as its top line scrolls out', () => {
    const entries = [user('hello', 3), other('assistant', 20)];
    expect(judgeStickyUserMessage({ entries, scrollTop: 1, following: false })?.summary).toBe(
      'hello',
    );
  });

  it('keeps the message pinned while its body is still partially visible', () => {
    const entries = [user('multi\nline\nmessage', 5), other('assistant', 20)];
    expect(judgeStickyUserMessage({ entries, scrollTop: 1, following: false })?.summary).toBe(
      'multi',
    );
    expect(judgeStickyUserMessage({ entries, scrollTop: 2, following: false })?.summary).toBe(
      'multi line',
    );
    for (const scrollTop of [3, 4, 5, 6]) {
      expect(
        judgeStickyUserMessage({ entries, scrollTop, following: false })?.summary,
        `scrollTop ${scrollTop}`,
      ).toBe('multi line message');
    }
  });

  it('merges every fully scrolled-out logical line into the summary', () => {
    const entries: StickyJudgmentEntry[] = [
      { kind: 'user', content: 'one\ntwo\nthree', height: 3, lineHeights: [1, 1, 1] },
      other('assistant', 20),
    ];
    expect(judgeStickyUserMessage({ entries, scrollTop: 1, following: false })?.summary).toBe(
      'one',
    );
    expect(judgeStickyUserMessage({ entries, scrollTop: 2, following: false })?.summary).toBe(
      'one two',
    );
    expect(judgeStickyUserMessage({ entries, scrollTop: 3, following: false })?.summary).toBe(
      'one two three',
    );
    expect(judgeStickyUserMessage({ entries, scrollTop: 10, following: false })?.summary).toBe(
      'one two three',
    );
  });

  it('counts wrapped visual rows when measuring scrolled-out lines', () => {
    const entries: StickyJudgmentEntry[] = [
      { kind: 'user', content: 'a long line\nnext', height: 3, lineHeights: [2, 1] },
      other('assistant', 20),
    ];
    expect(judgeStickyUserMessage({ entries, scrollTop: 1, following: false })?.summary).toBe(
      'a long line',
    );
    expect(judgeStickyUserMessage({ entries, scrollTop: 2, following: false })?.summary).toBe(
      'a long line',
    );
    expect(judgeStickyUserMessage({ entries, scrollTop: 3, following: false })?.summary).toBe(
      'a long line next',
    );
  });

  it('skips leading blank lines when merging scrolled-out lines', () => {
    const entries: StickyJudgmentEntry[] = [
      { kind: 'user', content: '\n\none\ntwo', height: 5, contentOffset: 3, lineHeights: [1, 1] },
      other('assistant', 20),
    ];
    expect(judgeStickyUserMessage({ entries, scrollTop: 4, following: false })?.summary).toBe(
      'one',
    );
    expect(judgeStickyUserMessage({ entries, scrollTop: 5, following: false })?.summary).toBe(
      'one two',
    );
  });

  it('switches the pinned message when the next message first line scrolls out', () => {
    const entries = [
      user('first question', 3),
      other('assistant', 7),
      user('second question', 3),
      other('assistant', 20),
    ];
    // The second message's head is exactly at the viewport top: still the first one's pin.
    expect(judgeStickyUserMessage({ entries, scrollTop: 10, following: false })?.summary).toBe(
      'first question',
    );
    expect(judgeStickyUserMessage({ entries, scrollTop: 11, following: false })?.summary).toBe(
      'second question',
    );
  });

  it('keeps the previous message pinned while the next message head is visible at the top', () => {
    const entries = [
      user('first question', 3),
      other('assistant', 7),
      user('second question', 3),
      other('assistant', 20),
    ];
    for (const scrollTop of [8, 9, 10]) {
      expect(
        judgeStickyUserMessage({ entries, scrollTop, following: false })?.summary,
        `scrollTop ${scrollTop}`,
      ).toBe('first question');
    }
  });

  it('keeps the clicked message pinned at its own jump landing', () => {
    const entries: StickyJudgmentEntry[] = [
      other('assistant', 4),
      { kind: 'user', content: 'hello', height: 2, contentOffset: 1, lineHeights: [1] },
      other('assistant', 20),
    ];
    const judgment = judgeStickyUserMessage({ entries, scrollTop: 6, following: false });
    expect(judgment?.targetY).toBe(6);
    expect(
      judgeStickyUserMessage({ entries, scrollTop: judgment!.targetY, following: false })?.summary,
    ).toBe('hello');
  });

  it('targets one line past the first content line for click jumps', () => {
    const entries: StickyJudgmentEntry[] = [
      { kind: 'user', content: 'hello', height: 3, contentOffset: 1, lineHeights: [1] },
      other('assistant', 20),
    ];
    expect(judgeStickyUserMessage({ entries, scrollTop: 3, following: false })?.targetY).toBe(2);
  });

  it('clamps the content offset to the entry height when targeting jumps', () => {
    const entries: StickyJudgmentEntry[] = [
      { kind: 'user', content: 'hello', height: 2, contentOffset: 9, lineHeights: [1] },
      other('assistant', 20),
    ];
    expect(judgeStickyUserMessage({ entries, scrollTop: 3, following: false })?.targetY).toBe(3);
  });

  it('pins the latest user message while following once its first line scrolls out', () => {
    const entries = [
      user('old question', 3),
      other('assistant', 30),
      user('current question', 3),
      other('tool_call', 40),
    ];
    const judgment = judgeStickyUserMessage({ entries, scrollTop: 40, following: true });
    expect(judgment?.summary).toBe('current question');
    expect(judgment?.targetY).toBe(34);
  });

  it('suppresses earlier messages while following when the latest first line is still visible', () => {
    const entries = [
      user('old question', 3),
      other('assistant', 30),
      user('current question', 3),
      other('tool_call', 2),
    ];
    expect(judgeStickyUserMessage({ entries, scrollTop: 33, following: true })).toBeNull();
  });

  it('falls back to plain geometry once the user stops following output', () => {
    const entries = [
      user('old question', 3),
      other('assistant', 30),
      user('current question', 3),
      other('tool_call', 2),
    ];
    expect(judgeStickyUserMessage({ entries, scrollTop: 33, following: false })?.summary).toBe(
      'old question',
    );
  });

  it('treats steer messages (user kind without a bullet override) as candidates', () => {
    const entries = [user('steer: also update the docs', 2), other('tool_call', 20)];
    const judgment = judgeStickyUserMessage({ entries, scrollTop: 3, following: false });
    expect(judgment?.summary).toBe('steer: also update the docs');
  });

  it('excludes bash echo entries whose bullet is suppressed', () => {
    const entries = [user('$ pnpm test', 1, ''), other('status', 20)];
    expect(judgeStickyUserMessage({ entries, scrollTop: 5, following: false })).toBeNull();
  });

  it('excludes non-user transcript entries', () => {
    const kinds: TranscriptEntryKind[] = [
      'assistant',
      'tool_call',
      'thinking',
      'status',
      'skill_activation',
      'plugin_command',
      'cron',
      'goal',
      'welcome',
    ];
    for (const kind of kinds) {
      const entries = [other(kind, 3), other('assistant', 20)];
      expect(
        judgeStickyUserMessage({ entries, scrollTop: 10, following: false }),
        kind,
      ).toBeNull();
    }
  });

  it('excludes user messages without any text (image-only messages)', () => {
    const entries = [user('', 4), other('assistant', 20)];
    expect(judgeStickyUserMessage({ entries, scrollTop: 10, following: false })).toBeNull();
  });

  it('computes positions from entry heights, ignoring zero-height entries', () => {
    const entries = [
      other('assistant', 4),
      other('goal', 0),
      user('hello', 2),
      other('assistant', 10),
    ];
    const judgment = judgeStickyUserMessage({ entries, scrollTop: 5, following: false });
    expect(judgment?.targetY).toBe(5);
  });

  it('returns the cleaned first-line summary in the judgment', () => {
    const entries = [user('line one\nline two\n\nother paragraph', 5), other('assistant', 10)];
    expect(judgeStickyUserMessage({ entries, scrollTop: 1, following: false })?.summary).toBe(
      'line one',
    );
  });

  it('pins the last candidate whose first line scrolled out when everything above passed', () => {
    const entries = [
      user('first', 2),
      other('assistant', 5),
      user('second', 2),
      other('assistant', 5),
    ];
    const judgment = judgeStickyUserMessage({ entries, scrollTop: 100, following: false });
    expect(judgment?.summary).toBe('second');
  });
});
