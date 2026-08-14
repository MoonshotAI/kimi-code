/**
 * Tests for `reduceContextTranscript` — the wire-transcript reducer used by the
 * snapshot and messages endpoints. Mirrors v1 `reduceWireRecords` expectations:
 * compaction keeps the prefix and appends a summary marker; undo splices the
 * tail along the shared `conversationTime` cut decision — a blocked undo
 * (compaction summary / clear floor / too few anchors) leaves the transcript
 * unchanged, exactly as the model Op no-ops; clear keeps the transcript but
 * resets the folded view.
 *
 * The `transcript/model fold parity` block replays one record stream through
 * both the transcript reducer and the model fold (`foldAppendMessage` /
 * `foldLoopEvent` / `contextOps`) and asserts after EVERY record prefix that
 * the transcript's current conversation (the tail of `foldedLength` entries)
 * matches the model's messages. Two divergences are by design: the
 * model-facing compaction summary text (`contextSummary`) differs from the
 * display-facing one (`summary`), so comparisons mask summary content; and
 * compaction pauses the check until the next clear, because the display's
 * `foldedLength` is a UI collapse metric (kept users + summary marker, and
 * legacy records put the summary first in the model but last in the display) —
 * clear realigns the two views.
 */

import { describe, expect, it } from 'vitest';

import {
  createContextTranscriptReducer,
  reduceContextTranscript,
  type ContextTranscript,
} from '#/agent/contextMemory/contextTranscript';
import {
  contextApplyCompaction,
  contextClear,
  contextUndo,
} from '#/agent/contextMemory/contextOps';
import {
  foldAppendMessage,
  foldLoopEvent,
  type LoopRecordedEvent,
} from '#/agent/contextMemory/loopEventFold';
import {
  EMPTY_FOLD,
  type ContextMessage,
  type ContextState,
  type PromptOrigin,
} from '#/agent/contextMemory/types';
import type { WireRecord } from '#/wire/record';

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

function appendMessage(message: ContextMessage): WireRecord {
  return { type: 'context.append_message', message };
}

function loopEvent(event: LoopRecordedEvent): WireRecord {
  return { type: 'context.append_loop_event', event };
}

function assistantStep(uuid: string, text: string): WireRecord[] {
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
): WireRecord {
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

function undo(count: number): WireRecord {
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

  it('removes a pre-anchor image compression reminder owned by the undone prompt', () => {
    const result = reduceContextTranscript([
      appendMessage(
        userMessage('compressed image', {
          kind: 'injection',
          variant: 'image_compression',
          ownerPromptId: 'prompt-1',
        }),
      ),
      appendMessage({ ...userMessage('undo me', { kind: 'user' }), id: 'prompt-1' }),
      appendMessage(assistantMessage('undone answer')),
      undo(1),
      appendMessage(userMessage('keep me', { kind: 'user' })),
      appendMessage(assistantMessage('kept answer')),
    ]);

    expect(texts(result)).toEqual(['keep me', 'kept answer']);
  });

  it('undo blocked at a compaction summary leaves the transcript unchanged', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('old')),
      compaction('SUM', 1, 1),
      appendMessage(userMessage('recent')),
      appendMessage(assistantMessage('answer')),
      undo(2),
    ]);
    expect(texts(result)).toEqual(['old', 'SUM', 'recent', 'answer']);
    expect(result.foldedLength).toBe(4);
  });

  it('undo up to a compaction summary still applies', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('old')),
      compaction('SUM', 1, 1),
      appendMessage(userMessage('recent')),
      appendMessage(assistantMessage('answer')),
      undo(1),
    ]);
    expect(texts(result)).toEqual(['old', 'SUM']);
    expect(result.foldedLength).toBe(2);
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

  it('undo blocked at a clear floor leaves the transcript unchanged', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('u1')),
      { type: 'context.clear' },
      appendMessage(userMessage('u2')),
      appendMessage(assistantMessage('a2')),
      undo(2),
    ]);
    expect(texts(result)).toEqual(['u1', 'u2', 'a2']);
    expect(result.foldedLength).toBe(2);
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

  it('drops an output-free assistant at step.end, mirroring the live fold', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('q')),
      loopEvent({ type: 'step.begin', uuid: 's1' }),
      loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'think', think: '' } }),
      loopEvent({ type: 'step.end', uuid: 's1' }),
    ]);
    expect(result.entries.map((m) => m.role)).toEqual(['user']);
    expect(result.foldedLength).toBe(1);
  });

  it('drops a failed attempt left open when the retry begins', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('q')),
      loopEvent({ type: 'step.begin', uuid: 's1' }),
      loopEvent({ type: 'step.begin', uuid: 's2' }),
      loopEvent({ type: 'content.part', stepUuid: 's2', part: { type: 'text', text: 'recovered' } }),
      loopEvent({ type: 'step.end', uuid: 's2' }),
    ]);
    expect(result.entries.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(texts(result)).toEqual(['q', 'recovered']);
    expect(result.foldedLength).toBe(2);
  });

  it('keeps settled steps that carry any sendable output', () => {
    const result = reduceContextTranscript([
      appendMessage(userMessage('q')),
      loopEvent({ type: 'step.begin', uuid: 's1' }),
      loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'think', think: 'real' } }),
      loopEvent({ type: 'step.end', uuid: 's1' }),
      loopEvent({ type: 'step.begin', uuid: 's2' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's2',
        part: { type: 'think', think: '', encrypted: 'sig' },
      }),
      loopEvent({ type: 'step.end', uuid: 's2' }),
      loopEvent({ type: 'step.begin', uuid: 's3' }),
      loopEvent({ type: 'content.part', stepUuid: 's3', part: { type: 'think', think: '' } }),
      loopEvent({ type: 'content.part', stepUuid: 's3', part: { type: 'text', text: 'answer' } }),
      loopEvent({ type: 'step.end', uuid: 's3' }),
    ]);
    expect(result.entries.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'assistant']);
    expect(result.foldedLength).toBe(4);
  });
});

describe('transcript/model fold parity', () => {
  function applyRecordToModel(state: ContextState, record: WireRecord): ContextState {
    switch (record.type) {
      case 'context.append_message':
        return foldAppendMessage(state, record['message'] as ContextMessage);
      case 'context.append_loop_event':
        return foldLoopEvent(state, record['event'] as LoopRecordedEvent);
      case 'context.undo':
        return contextUndo.apply(state, { count: record['count'] as number });
      case 'context.clear':
        return contextClear.apply(state, {});
      case 'context.apply_compaction':
        return contextApplyCompaction.apply(
          state,
          record as unknown as Parameters<typeof contextApplyCompaction.apply>[1],
        );
      default:
        return state;
    }
  }

  function currentOf(result: ContextTranscript): readonly ContextMessage[] {
    return result.entries.slice(result.entries.length - result.foldedLength);
  }

  function comparable(messages: readonly ContextMessage[]): unknown {
    return messages.map((m) => ({
      ...m,
      content: m.origin?.kind === 'compaction_summary' ? '<summary>' : m.content,
    }));
  }

  function expectParity(records: WireRecord[]): void {
    let state: ContextState = { messages: [], fold: EMPTY_FOLD };
    const reducer = createContextTranscriptReducer();
    let aligned = true;
    for (const record of records) {
      state = applyRecordToModel(state, record);
      reducer.add(record);
      if (record.type === 'context.apply_compaction') aligned = false;
      if (record.type === 'context.clear') aligned = true;
      if (!aligned) continue;
      const result = reducer.result();
      expect(comparable(currentOf(result))).toEqual(comparable(state.messages));
    }
  }

  it('matches across retries, mid-exchange deferral, undo, compaction, and clear', () => {
    expectParity([
      appendMessage(userMessage('u1', { kind: 'user' })),
      ...assistantStep('s1', 'a1'),
      loopEvent({ type: 'step.begin', uuid: 's2' }),
      loopEvent({ type: 'content.part', stepUuid: 's2', part: { type: 'text', text: 'half' } }),
      loopEvent({ type: 'tool.call', stepUuid: 's2', toolCallId: 'c1', name: 'Bash', args: {} }),
      loopEvent({ type: 'step.begin', uuid: 's3' }),
      loopEvent({ type: 'content.part', stepUuid: 's3', part: { type: 'text', text: 'a3' } }),
      loopEvent({ type: 'tool.call', stepUuid: 's3', toolCallId: 'c2', name: 'Read', args: {} }),
      appendMessage(userMessage('injected mid-exchange')),
      loopEvent({ type: 'tool.result', toolCallId: 'c2', result: { output: 'ok' } }),
      loopEvent({ type: 'step.end', uuid: 's3' }),
      appendMessage(userMessage('u2', { kind: 'user' })),
      undo(1),
      compaction('SUM', 7, 2),
      appendMessage(userMessage('u3', { kind: 'user' })),
      { type: 'context.clear' },
      ...assistantStep('s4', 'a4'),
    ]);
  });

  it('matches when a tool exchange is interrupted without a retry', () => {
    expectParity([
      appendMessage(userMessage('q', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's1' }),
      loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'c1', name: 'Bash', args: {} }),
      appendMessage(userMessage('next', { kind: 'user' })),
      ...assistantStep('s2', 'done'),
      undo(1),
      undo(1),
    ]);
  });
});
