import { afterEach, describe, expect, it } from 'vitest';

import type { TranscriptEntry } from '#/tui/types';
import { groupTurns, readEnvInt, turnsToTrim } from '#/tui/utils/transcript-window';

let seq = 0;
function makeEntry(
  turnId: string | undefined,
  kind: TranscriptEntry['kind'] = 'assistant',
): TranscriptEntry {
  return { id: String(++seq), kind, turnId, renderMode: 'markdown', content: '' };
}
function tool(turnId: string): TranscriptEntry {
  return makeEntry(turnId, 'tool_call');
}
function msg(turnId: string | undefined): TranscriptEntry {
  return makeEntry(turnId, 'assistant');
}

describe('groupTurns', () => {
  it('groups consecutive entries with the same turnId', () => {
    const turns = groupTurns([msg('a'), tool('a'), msg('b')]);
    expect(turns.map((t) => t.turnId)).toEqual(['a', 'b']);
    expect(turns[0]!.entries).toHaveLength(2);
    expect(turns[1]!.entries).toHaveLength(1);
  });

  it('attaches leading undefined turnId entries to the following turn', () => {
    // A user message (undefined turnId) followed by its response should be one turn.
    const turns = groupTurns([msg(undefined), tool('1'), msg('1')]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBe('1');
    expect(turns[0]!.entries).toHaveLength(3);
  });

  it('attaches multiple consecutive undefined entries to the following turn', () => {
    const turns = groupTurns([msg(undefined), msg(undefined), msg('a')]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBe('a');
    expect(turns[0]!.entries).toHaveLength(3);
  });

  it('makes trailing undefined entries their own turn', () => {
    const turns = groupTurns([msg('a'), msg(undefined)]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turnId).toBe('a');
    expect(turns[1]!.turnId).toBeUndefined();
    expect(turns[1]!.entries).toHaveLength(1);
  });

  it('splits a `!` shell stretch into one turn per command', () => {
    const echo = () => makeEntry(undefined, 'user');
    const out = () => makeEntry(undefined, 'status');
    const turns = groupTurns([echo(), out(), echo(), out(), echo(), out()]);
    expect(turns).toHaveLength(3);
    for (const turn of turns) {
      expect(turn.turnId).toBeUndefined();
      expect(turn.entries.map((e) => e.kind)).toEqual(['user', 'status']);
    }
  });

  it('still attaches a real prompt to the following defined turn', () => {
    const prompt = makeEntry(undefined, 'user');
    const turns = groupTurns([prompt, tool('7'), msg('7')]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBe('7');
    expect(turns[0]!.entries[0]).toBe(prompt);
  });

  it('flushes a buffered `!` run when the next prompt arrives', () => {
    const echo = makeEntry(undefined, 'user');
    const out = makeEntry(undefined, 'status');
    const prompt = makeEntry(undefined, 'user');
    const turns = groupTurns([echo, out, prompt, msg('3')]);
    expect(turns.map((t) => t.turnId)).toEqual([undefined, '3']);
    expect(turns[0]!.entries).toEqual([echo, out]);
    expect(turns[1]!.entries).toEqual([prompt, turns[1]!.entries[1]!]);
  });
});

describe('turnsToTrim', () => {
  it('returns empty when turn count is within maxTurns', () => {
    const turns = groupTurns([msg('a'), msg('b'), msg('c')]); // 3 turns
    expect(turnsToTrim(turns, 5, 1).size).toBe(0);
  });

  it('does not trim within the hysteresis band', () => {
    const turns = groupTurns([msg('a'), msg('b'), msg('c')]); // 3 turns
    expect(turnsToTrim(turns, 2, 1).size).toBe(0); // 3 <= 2 + 1
  });

  it('trims oldest turns first', () => {
    const entries = [msg('a'), msg('b'), msg('c'), msg('d')]; // 4 turns
    const turns = groupTurns(entries);
    const removed = turnsToTrim(turns, 2, 0);
    expect(removed.has(entries[0]!)).toBe(true);
    expect(removed.has(entries[1]!)).toBe(true);
    expect(removed.has(entries[2]!)).toBe(false);
    expect(removed.has(entries[3]!)).toBe(false);
  });

  it('never trims the most recent turn', () => {
    // A single turn is never removed, even if it is huge.
    const entries = Array.from({ length: 200 }, () => tool('solo'));
    const turns = groupTurns(entries); // 1 turn
    const removed = turnsToTrim(turns, 2, 0);
    expect(removed.size).toBe(0);
  });

  it('trims old `!` command turns in a shell-heavy session', () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry(undefined, 'user'), makeEntry(undefined, 'status'));
    }
    const turns = groupTurns(entries); // 10 small turns, one per command
    expect(turns).toHaveLength(10);
    const removed = turnsToTrim(turns, 3, 0);
    // 10 > 3, oldest 7 commands trimmed; the newest 3 stay.
    expect(removed.size).toBe(14);
    expect(removed.has(entries[0]!)).toBe(true);
    expect(removed.has(entries[13]!)).toBe(true);
    expect(removed.has(entries[14]!)).toBe(false);
    expect(removed.has(entries[19]!)).toBe(false);
  });
});

describe('readEnvInt', () => {
  const KEY = 'KIMI_CODE_TUI_TEST_INT';
  afterEach(() => {
    delete process.env[KEY];
  });

  it('returns fallback when unset', () => {
    expect(readEnvInt(KEY, 7)).toBe(7);
  });

  it('reads a valid integer', () => {
    process.env[KEY] = '42';
    expect(readEnvInt(KEY, 7)).toBe(42);
  });

  it('accepts 0', () => {
    process.env[KEY] = '0';
    expect(readEnvInt(KEY, 7)).toBe(0);
  });

  it('falls back on negative', () => {
    process.env[KEY] = '-1';
    expect(readEnvInt(KEY, 7)).toBe(7);
  });

  it('falls back on non-integer', () => {
    process.env[KEY] = 'abc';
    expect(readEnvInt(KEY, 7)).toBe(7);
  });

  it('falls back on empty/whitespace', () => {
    process.env[KEY] = '  ';
    expect(readEnvInt(KEY, 7)).toBe(7);
  });
});
