import { describe, expect, it } from 'vitest';

import type { Message, ToolCall } from '#/kosong/contract/message';

import { ToolCallIdNormalizer } from '#/agent/llmRequester/toolCallIdNormalizer';

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

describe('ToolCallIdNormalizer', () => {
  it('passes first-seen ids through unchanged', () => {
    const normalizer = new ToolCallIdNormalizer();
    const response = normalizer.beginResponse();

    expect(response.remapStreamedId('call_1', 0)).toBe('call_1');
    expect(response.remapStreamedId('call_2', 1)).toBe('call_2');
    expect(response.remapped).toEqual([]);
  });

  it('rewrites an id already claimed by an earlier response', () => {
    const normalizer = new ToolCallIdNormalizer();
    normalizer.beginResponse().remapStreamedId('Bash_0', 0);

    const next = normalizer.beginResponse();
    expect(next.remapStreamedId('Bash_0', 0)).toBe('Bash_0__2');
    expect(next.remapped).toEqual([{ raw: 'Bash_0', assigned: 'Bash_0__2' }]);

    const third = normalizer.beginResponse();
    expect(third.remapStreamedId('Bash_0', 0)).toBe('Bash_0__3');
  });

  it('rewrites duplicates within one response and keeps stream/finalized assignment consistent', () => {
    const normalizer = new ToolCallIdNormalizer();
    const response = normalizer.beginResponse();

    expect(response.remapStreamedId('Bash_0', 0)).toBe('Bash_0');
    expect(response.remapStreamedId('Bash_0', 1)).toBe('Bash_0__2');
    // A re-emitted function part for the same stream index keeps its assignment.
    expect(response.remapStreamedId('Bash_0', 1)).toBe('Bash_0__2');

    const finalized = response.remapFinalizedCalls([call('Bash_0'), call('Bash_0')]);
    expect(finalized.map((c) => c.id)).toEqual(['Bash_0', 'Bash_0__2']);
  });

  it('seeds the seen set from restored context so a replayed id is rewritten on first sight', () => {
    const normalizer = new ToolCallIdNormalizer();
    normalizer.seedFrom(historyWith('Bash_0'));
    normalizer.seedFrom(historyWith('ignored')); // seeding happens once

    const response = normalizer.beginResponse();
    expect(response.remapStreamedId('Bash_0', 0)).toBe('Bash_0__2');
    expect(response.remapStreamedId('ignored', 1)).toBe('ignored');
  });

  it('claims tool result ids from history as well', () => {
    const normalizer = new ToolCallIdNormalizer();
    normalizer.seedFrom([
      { role: 'tool', content: [], toolCalls: [], toolCallId: 'Bash_1' },
    ]);

    expect(normalizer.beginResponse().remapStreamedId('Bash_1', 0)).toBe('Bash_1__2');
  });

  it('rollback reverts the attempt claims so a retry reuses the raw ids', () => {
    const normalizer = new ToolCallIdNormalizer();
    const failed = normalizer.beginResponse();
    failed.remapStreamedId('Bash_0', 0);
    failed.remapStreamedId('Bash_1', 1);
    failed.rollback();

    const retry = normalizer.beginResponse();
    expect(retry.remapStreamedId('Bash_0', 0)).toBe('Bash_0');
    expect(retry.remapStreamedId('Bash_1', 1)).toBe('Bash_1');
  });

  it('rollback does not remove ids claimed by committed earlier responses', () => {
    const normalizer = new ToolCallIdNormalizer();
    normalizer.beginResponse().remapStreamedId('Bash_0', 0);

    const failed = normalizer.beginResponse();
    expect(failed.remapStreamedId('Bash_0', 0)).toBe('Bash_0__2');
    failed.rollback();

    const next = normalizer.beginResponse();
    expect(next.remapStreamedId('Bash_0', 0)).toBe('Bash_0__2');
  });

  it('mints on the spot for finalized calls that never streamed a part', () => {
    const normalizer = new ToolCallIdNormalizer();
    const response = normalizer.beginResponse();
    response.remapStreamedId('Bash_0', 0);

    const finalized = response.remapFinalizedCalls([call('Bash_0'), call('late_1'), call('late_1')]);
    expect(finalized.map((c) => c.id)).toEqual(['Bash_0', 'late_1', 'late_1__2']);
  });

  it('returns the original array reference when nothing changed', () => {
    const normalizer = new ToolCallIdNormalizer();
    const response = normalizer.beginResponse();
    const calls = [call('call_1')];
    expect(response.remapFinalizedCalls(calls)).toBe(calls);
  });
});
