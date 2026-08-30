import { describe, expect, it } from 'vitest';

import type { Message, ToolCall } from '#/kosong/contract/message';

import {
  collectToolCallIds,
  ToolCallIdResponseNormalizer,
} from '#/actor/llmRequester/internal/toolCallIdNormalizer';

function call(id: string, streamIndex?: number): ToolCall {
  return { type: 'function', id, name: 'Bash', arguments: '{}', _streamIndex: streamIndex };
}

function historyWith(...ids: string[]): Message[] {
  return [
    {
      role: 'assistant',
      content: [],
      toolCalls: ids.map((id) => call(id)),
    },
  ];
}

function committed(seen: ReadonlySet<string>, response: ToolCallIdResponseNormalizer): ReadonlySet<string> {
  return new Set([...seen, ...response.claimedIds]);
}

describe('ToolCallIdResponseNormalizer', () => {
  it('passes first-seen ids through unchanged', () => {
    const response = new ToolCallIdResponseNormalizer(new Set());

    expect(response.remapStreamedId('call_1', 0)).toBe('call_1');
    expect(response.remapStreamedId('call_2', 1)).toBe('call_2');
    expect(response.remapped).toEqual([]);
    expect(response.claimedIds).toEqual(['call_1', 'call_2']);
  });

  it('rewrites an id already claimed by an earlier committed response', () => {
    let seen: ReadonlySet<string> = new Set();
    const first = new ToolCallIdResponseNormalizer(seen);
    first.remapStreamedId('Bash_0', 0);
    seen = committed(seen, first);

    const next = new ToolCallIdResponseNormalizer(seen);
    expect(next.remapStreamedId('Bash_0', 0)).toBe('Bash_0__2');
    expect(next.remapped).toEqual([{ raw: 'Bash_0', assigned: 'Bash_0__2' }]);
    seen = committed(seen, next);

    const third = new ToolCallIdResponseNormalizer(seen);
    expect(third.remapStreamedId('Bash_0', 0)).toBe('Bash_0__3');
  });

  it('rewrites duplicates within one response and keeps stream/finalized assignment consistent', () => {
    const response = new ToolCallIdResponseNormalizer(new Set());

    expect(response.remapStreamedId('Bash_0', 0)).toBe('Bash_0');
    expect(response.remapStreamedId('Bash_0', 1)).toBe('Bash_0__2');
    expect(response.remapStreamedId('Bash_0', 1)).toBe('Bash_0__2');

    const finalized = response.remapFinalizedCalls([call('Bash_0'), call('Bash_0')]);
    expect(finalized.map((c) => c.id)).toEqual(['Bash_0', 'Bash_0__2']);
  });

  it('rewrites a replayed history id on first sight when seeded from restored context', () => {
    const seen = new Set(collectToolCallIds(historyWith('Bash_0')));

    const response = new ToolCallIdResponseNormalizer(seen);
    expect(response.remapStreamedId('Bash_0', 0)).toBe('Bash_0__2');
    expect(response.remapStreamedId('unseen', 1)).toBe('unseen');
  });

  it('collects tool result ids from history as well', () => {
    const seen = new Set(
      collectToolCallIds([{ role: 'tool', content: [], toolCalls: [], toolCallId: 'Bash_1' }]),
    );

    expect(new ToolCallIdResponseNormalizer(seen).remapStreamedId('Bash_1', 0)).toBe('Bash_1__2');
  });

  it('discarding a failed attempt lets a retry reuse the raw ids', () => {
    const seen: ReadonlySet<string> = new Set();
    const failed = new ToolCallIdResponseNormalizer(seen);
    failed.remapStreamedId('Bash_0', 0);
    failed.remapStreamedId('Bash_1', 1);

    const retry = new ToolCallIdResponseNormalizer(seen);
    expect(retry.remapStreamedId('Bash_0', 0)).toBe('Bash_0');
    expect(retry.remapStreamedId('Bash_1', 1)).toBe('Bash_1');
  });

  it('keeps ids claimed by committed earlier responses when a later attempt is discarded', () => {
    let seen: ReadonlySet<string> = new Set();
    const first = new ToolCallIdResponseNormalizer(seen);
    first.remapStreamedId('Bash_0', 0);
    seen = committed(seen, first);

    const failed = new ToolCallIdResponseNormalizer(seen);
    expect(failed.remapStreamedId('Bash_0', 0)).toBe('Bash_0__2');

    const next = new ToolCallIdResponseNormalizer(seen);
    expect(next.remapStreamedId('Bash_0', 0)).toBe('Bash_0__2');
  });

  it('mints on the spot for finalized calls that never streamed a part', () => {
    const response = new ToolCallIdResponseNormalizer(new Set());
    response.remapStreamedId('Bash_0', 0);

    const finalized = response.remapFinalizedCalls([call('Bash_0'), call('late_1'), call('late_1')]);
    expect(finalized.map((c) => c.id)).toEqual(['Bash_0', 'late_1', 'late_1__2']);
  });

  it('returns the original array reference when nothing changed', () => {
    const response = new ToolCallIdResponseNormalizer(new Set());
    const calls = [call('call_1')];
    expect(response.remapFinalizedCalls(calls)).toBe(calls);
  });
});
