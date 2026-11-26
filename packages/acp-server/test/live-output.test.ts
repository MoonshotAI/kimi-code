import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_OUTPUT_INTERVAL_MS, LIVE_OUTPUT_MAX_CHARS, LiveToolOutput } from '../src/live-output';

describe('LiveToolOutput', () => {
  let shown: Array<readonly [string, string]>;
  let output: LiveToolOutput;

  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
    output = new LiveToolOutput((toolCallId, text) => {
      shown.push([toolCallId, text]);
    });
  });

  afterEach(() => {
    output.dispose();
    vi.useRealTimers();
  });

  it('shows the first output at once, then at most one update per interval with everything printed so far', () => {
    output.append('1:a', 0, 'one\n');
    expect(shown).toEqual([['1:a', 'one\n']]);

    output.append('1:a', 4, 'two\n');
    output.append('1:a', 8, 'three\n');
    vi.advanceTimersByTime(LIVE_OUTPUT_INTERVAL_MS - 1);
    expect(shown).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual([['1:a', 'one\n'], ['1:a', 'one\ntwo\nthree\n']]);

    vi.advanceTimersByTime(LIVE_OUTPUT_INTERVAL_MS);
    expect(shown).toHaveLength(2);
    output.append('1:a', 14, 'four\n');
    expect(shown.at(-1)).toEqual(['1:a', 'one\ntwo\nthree\nfour\n']);
  });

  it('keeps each call to its own output', () => {
    output.append('1:a', 0, 'from a\n');
    output.append('1:b', 0, 'from b\n');

    expect(shown).toEqual([['1:a', 'from a\n'], ['1:b', 'from b\n']]);
  });

  it('skips a chunk that does not continue the output it has, counting the offset in bytes', () => {
    output.append('1:a', 0, 'é');
    output.append('1:a', 0, 'é');
    output.append('1:a', 9, 'gap');
    output.append('1:a', 2, '!');
    vi.advanceTimersByTime(LIVE_OUTPUT_INTERVAL_MS);

    expect(shown).toEqual([['1:a', 'é'], ['1:a', 'é!']]);
  });

  it('keeps only the last characters of a long output and says it cut the start', () => {
    output.append('1:a', 0, 'x'.repeat(LIVE_OUTPUT_MAX_CHARS));
    output.append('1:a', LIVE_OUTPUT_MAX_CHARS, 'tail');
    vi.advanceTimersByTime(LIVE_OUTPUT_INTERVAL_MS);

    expect(shown.at(-1)?.[1]).toBe(`[…truncated]\n${'x'.repeat(LIVE_OUTPUT_MAX_CHARS - 4)}tail`);
  });

  it('sends nothing more for a call once it ends, not even output still waiting to be sent', () => {
    output.append('1:a', 0, 'one\n');
    output.append('1:a', 4, 'two\n');
    output.end('1:a');
    vi.advanceTimersByTime(LIVE_OUTPUT_INTERVAL_MS);

    expect(shown).toEqual([['1:a', 'one\n']]);
  });

  it('drops the output still waiting for every call when disposed', () => {
    output.append('1:a', 0, 'one\n');
    output.append('1:a', 4, 'two\n');
    output.append('1:b', 0, 'other\n');
    output.append('1:b', 6, 'more\n');
    output.dispose();
    vi.advanceTimersByTime(LIVE_OUTPUT_INTERVAL_MS);

    expect(shown).toEqual([['1:a', 'one\n'], ['1:b', 'other\n']]);
  });
});
