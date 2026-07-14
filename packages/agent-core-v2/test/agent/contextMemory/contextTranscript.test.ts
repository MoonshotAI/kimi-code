/**
 * Tests for `reduceContextTranscript` — the wire-transcript reducer used by the
 * snapshot and messages endpoints. Mirrors v1 `reduceWireRecords` expectations:
 * compaction keeps the prefix and appends a summary marker; undo removes the
 * tail but stops at compaction summaries / clear floors; clear keeps the
 * transcript but resets the folded view.
 */

import { describe, expect, it } from 'vitest';

import {
  reduceContextTranscript,
  type ContextTranscript,
} from '#/agent/contextMemory/contextTranscript';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { PersistedRecord } from '#/wire/wireService';

function userMessage(text: string, origin?: PromptOrigin): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    ...(origin === undefined ? {} : { origin }),
  };
}

function assistantMessage(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function appendMessage(message: ContextMessage): PersistedRecord {
  return { type: 'context.append_message', message };
}

function loopEvent(event: LoopRecordedEvent): PersistedRecord {
  return { type: 'context.append_loop_event', event };
}

function assistantStep(uuid: string, text: string): PersistedRecord[] {
  return [
    loopEvent({ type: 'step.begin', uuid }),
    loopEvent({ type: 'content.part', stepUuid: uuid, part: { type: 'text', text } }),
    loopEvent({ type: 'step.end', uuid }),
  ];
}

function compaction(
  summary: string,
  compactedCount: number,
  keptUserMessageCount?: number,
  keptHeadUserMessageCount?: number,
): PersistedRecord {
  return {
    type: 'context.apply_compaction',
    summary,
    contextSummary: `prefixed ${summary}`,
    compactedCount,
    tokensBefore: 1000,
    tokensAfter: 100,
    ...(keptUserMessageCount === undefined ? {} : { keptUserMessageCount }),
    ...(keptHeadUserMessageCount === undefined ? {} : { keptHeadUserMessageCount }),
  };
}

function undo(count: number): PersistedRecord {
  return { type: 'context.undo', count };
}

function texts(result: ContextTranscript): string[] {
  return result.entries.map((m) =>
    m.content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join(''),
  );
}

describe('reduceContextTranscript', () => {
  it('builds the transcript from append_message and loop events', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('u1')),
      ...assistantStep('s1', 'a1'),
    ]);
    expect(texts(result)).toEqual(['u1', 'a1']);
    expect(result.entries.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.foldedLength).toBe(2);
  });

  it('compaction keeps the prefix and appends a user-role summary marker', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('u1')),
      ...assistantStep('s1', 'a1'),
      appendMessage(userMessage('u2')),
      ...assistantStep('s2', 'a2'),
      compaction('SUM', 4),
      appendMessage(userMessage('u3')),
    ]);
    expect(texts(result)).toEqual(['u1', 'a1', 'u2', 'a2', 'SUM', 'u3']);
    expect(result.entries[4]!.origin).toEqual({ kind: 'compaction_summary' });
    expect(result.entries[4]!.role).toBe('user');
    expect(result.foldedLength).toBe(4);
  });

  it('uses the recorded kept-user count for foldedLength when present', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('u1')),
      appendMessage(userMessage('u2')),
      appendMessage(userMessage('u3')),
      compaction('SUM', 3, 1),
      appendMessage(userMessage('u4')),
    ]);
    expect(result.foldedLength).toBe(3);
  });

  it('accounts for the elision marker when the record kept a head segment', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('u1')),
      appendMessage(userMessage('u2')),
      ...assistantStep('s1', 'a1'),
      compaction('SUM', 3, 2, 1),
    ]);
    expect(result.foldedLength).toBe(4);
  });

  it('carries the originating wire record time per entry', () => {
    const result = reduceContextTranscript([
      { type: 'context.append_message', message: userMessage('u1'), time: 100 },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'st1' }, time: 200 },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', stepUuid: 'st1', toolCallId: 'c1', name: 'Bash' },
        time: 210,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'c1',
          result: { output: 'ok', isError: false },
        },
        time: 220,
      },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'st1' }, time: 230 },
      // No record time → undefined (falls back to session createdAt + index).
      { type: 'context.append_message', message: userMessage('u2') },
    ]);

    expect(result.entries.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(result.times).toEqual([100, 200, 220, undefined]);
  });

  it('preserves the pre-compaction assistant reply after a later undo', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('message A')),
      appendMessage(assistantMessage('reply A')),
      compaction('summary text', 2, 1),
      appendMessage(userMessage('message B')),
      appendMessage(assistantMessage('reply B')),
      undo(1),
    ]);
    expect(texts(result)).toEqual(['message A', 'reply A', 'summary text']);
    expect(result.entries.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.foldedLength).toBe(2);
  });

  it('undo without compaction keeps the earlier exchange intact', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('message A')),
      appendMessage(assistantMessage('reply A')),
      appendMessage(userMessage('message B')),
      appendMessage(assistantMessage('reply B')),
      undo(1),
    ]);
    expect(texts(result)).toEqual(['message A', 'reply A']);
  });

  it('undo stops at a compaction summary', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('old')),
      compaction('SUM', 1, 1),
      appendMessage(userMessage('recent')),
      appendMessage(assistantMessage('answer')),
      undo(2),
    ]);
    expect(texts(result)).toEqual(['old', 'SUM']);
  });

  it('clear keeps prior transcript entries but resets the folded view', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('u1')),
      appendMessage(userMessage('u2')),
      { type: 'context.clear' },
      appendMessage(userMessage('u3')),
    ]);
    expect(texts(result)).toEqual(['u1', 'u2', 'u3']);
    expect(result.foldedLength).toBe(1);
  });

  it('undo does not cross a clear floor', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('u1')),
      { type: 'context.clear' },
      appendMessage(userMessage('u2')),
      appendMessage(assistantMessage('a2')),
      undo(1),
    ]);
    expect(texts(result)).toEqual(['u1']);
    expect(result.foldedLength).toBe(0);
  });

  it('folds tool calls and results from loop events', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('q')),
      loopEvent({ type: 'step.begin', uuid: 's1' }),
      loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'hi' } }),
      loopEvent({
        type: 'tool.call',
        stepUuid: 's1',
        toolCallId: 'call_1',
        name: 'Bash',
        args: { command: 'echo hi' },
      }),
      loopEvent({ type: 'tool.result', toolCallId: 'call_1', result: { output: 'hi' } }),
      loopEvent({ type: 'step.end', uuid: 's1' }),
    ]);
    expect(result.entries.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(result.entries[1]!.toolCalls).toHaveLength(1);
    expect(result.entries[1]!.toolCalls[0]!.id).toBe('call_1');
    expect(result.entries[2]!.toolCallId).toBe('call_1');
    expect(result.foldedLength).toBe(3);
  });
});
