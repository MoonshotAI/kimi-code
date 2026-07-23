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

function promptTurn(input: string, origin: PromptOrigin): WireRecord {
  return { type: 'turn.prompt', input: [{ type: 'text', text: input }], origin };
}

function steerTurn(input: string): WireRecord {
  return {
    type: 'turn.steer',
    input: [{ type: 'text', text: input }],
    origin: { kind: 'user' },
  };
}

function emptySteerTurn(): WireRecord {
  return { type: 'turn.steer', input: [], origin: { kind: 'user' } };
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

  it('keeps stable turn ids when undo removes a steer after a hidden retry turn', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's0',
        turnId: '0',
        part: { type: 'text', text: 'a0' },
      }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      promptTurn('', { kind: 'retry' }),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '1' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's1',
        turnId: '1',
        part: { type: 'text', text: 'retry answer' },
      }),
      loopEvent({ type: 'step.end', uuid: 's1', turnId: '1' }),
      promptTurn('u2', { kind: 'user' }),
      appendMessage(userMessage('u2', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's2', turnId: '2' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's2',
        turnId: '2',
        part: { type: 'text', text: 'before steer' },
      }),
      loopEvent({ type: 'step.end', uuid: 's2', turnId: '2' }),
      steerTurn('remove me'),
      appendMessage(userMessage('remove me', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's3', turnId: '2' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's3',
        turnId: '2',
        part: { type: 'text', text: 'after steer' },
      }),
      loopEvent({ type: 'step.end', uuid: 's3', turnId: '2' }),
      undo(1),
    ]);

    expect(texts(result)).toEqual(['u0', 'a0', 'retry answer', 'u2', 'before steer']);
    expect(result.turnIds).toEqual([0, 0, 1, 2, 2]);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([0, 1, 2]);
  });

  it('promotes a legacy idle steer to the new turn reported by its loop events', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's0',
        turnId: '0',
        part: { type: 'text', text: 'a0' },
      }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      steerTurn('u1'),
      appendMessage(userMessage('u1', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '1' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's1',
        turnId: '1',
        part: { type: 'text', text: 'a1' },
      }),
      loopEvent({ type: 'step.end', uuid: 's1', turnId: '1' }),
    ]);

    expect(texts(result)).toEqual(['u0', 'a0', 'u1', 'a1']);
    expect(result.turnIds).toEqual([0, 0, 1, 1]);
    expect(result.turns).toMatchObject([
      { turnId: 0, input: [{ type: 'text', text: 'u0' }], origin: { kind: 'user' } },
      { turnId: 1, input: [{ type: 'text', text: 'u1' }], origin: { kind: 'user' } },
    ]);
  });

  it('removes the promoted legacy idle-steer turn when its anchor is undone', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's0',
        turnId: '0',
        part: { type: 'text', text: 'a0' },
      }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      steerTurn('u1'),
      appendMessage(userMessage('u1', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '1' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's1',
        turnId: '1',
        part: { type: 'text', text: 'a1' },
      }),
      loopEvent({ type: 'step.end', uuid: 's1', turnId: '1' }),
      undo(1),
    ]);

    expect(texts(result)).toEqual(['u0', 'a0']);
    expect(result.turnIds).toEqual([0, 0]);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([0]);
  });

  it.each(['messages-first', 'event-first'] as const)(
    'assigns multiple same-origin legacy steers FIFO when %s',
    (order) => {
      const steers = [steerTurn('u1'), steerTurn('u2')];
      const messages = [
        appendMessage(userMessage('u1', { kind: 'user' })),
        appendMessage(userMessage('u2', { kind: 'user' })),
      ];
      const stepBegin = loopEvent({ type: 'step.begin', uuid: 's1', turnId: '1' });
      const result = reduceContextTranscript([
        promptTurn('u0', { kind: 'user' }),
        appendMessage(userMessage('u0', { kind: 'user' })),
        loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
        loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
        ...steers,
        ...(order === 'messages-first' ? [...messages, stepBegin] : [stepBegin, ...messages]),
        loopEvent({
          type: 'content.part',
          stepUuid: 's1',
          turnId: '1',
          part: { type: 'text', text: 'a1' },
        }),
        loopEvent({ type: 'step.end', uuid: 's1', turnId: '1' }),
      ]);

      const idsByText = new Map(texts(result).map((text, index) => [text, result.turnIds[index]]));
      expect(idsByText.get('u1')).toBe(1);
      expect(idsByText.get('u2')).toBe(1);
      expect(idsByText.get('a1')).toBe(1);
      expect(result.turns[1]).toMatchObject({
        turnId: 1,
        input: [{ type: 'text', text: 'u1' }],
      });
    },
  );

  it('does not retain an empty steer after observing its turn', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      emptySteerTurn(),
      loopEvent({ type: 'step.begin', uuid: 'empty', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 'empty', turnId: '0' }),
      steerTurn('u1'),
      appendMessage(userMessage('u1', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '1' }),
      loopEvent({ type: 'step.end', uuid: 's1', turnId: '1' }),
    ]);

    expect(result.turnIds).toEqual([0, 1]);
    expect(result.turns).toMatchObject([
      { turnId: 0, input: [{ type: 'text', text: 'u0' }] },
      { turnId: 1, input: [{ type: 'text', text: 'u1' }] },
    ]);
    expect(result.stableTurnIds).toBe(true);
  });

  it('uses the message-producing steer as the opener when an empty steer precedes it', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      emptySteerTurn(),
      steerTurn('u1'),
      appendMessage(userMessage('u1', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '1' }),
      loopEvent({ type: 'step.end', uuid: 's1', turnId: '1' }),
      promptTurn('u2', { kind: 'user' }),
      appendMessage(userMessage('u2', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's2', turnId: '2' }),
      loopEvent({ type: 'step.end', uuid: 's2', turnId: '2' }),
    ]);

    expect(result.turnIds).toEqual([0, 1, 2]);
    expect(result.turns).toMatchObject([
      { turnId: 0, input: [{ type: 'text', text: 'u0' }] },
      { turnId: 1, input: [{ type: 'text', text: 'u1' }] },
      { turnId: 2, input: [{ type: 'text', text: 'u2' }] },
    ]);
    expect(result.stableTurnIds).toBe(true);
  });

  it('removes the message-producing steer turn on undo when an empty steer preceded it', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      emptySteerTurn(),
      steerTurn('u1'),
      appendMessage(userMessage('u1', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '1' }),
      loopEvent({ type: 'step.end', uuid: 's1', turnId: '1' }),
      undo(1),
    ]);

    expect(texts(result)).toEqual(['u0']);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([0]);
  });

  it('keeps restored task notifications off removed turn ids after undo', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      ...assistantStep('s0', 'a0'),
      promptTurn('u1', { kind: 'user' }),
      appendMessage(userMessage('u1', { kind: 'user' })),
      ...assistantStep('s1', 'a1'),
      undo(1),
      appendMessage(
        userMessage('task done', {
          kind: 'task',
          taskId: 'bash-001',
          status: 'completed',
          notificationId: 'task:bash-001:completed',
        }),
      ),
    ]);

    expect(texts(result)).toEqual(['u0', 'a0', 'task done']);
    expect(result.turnIds).toEqual([0, 0, 0]);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([0]);
    expect(result.stableTurnIds).toBe(true);
  });

  it('uses an active cancel turn id to resolve an idle steer before its first loop event', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      steerTurn('cancelled'),
      appendMessage(userMessage('cancelled', { kind: 'user' })),
      { type: 'turn.cancel', turnId: 1, target: 'active' },
      promptTurn('u2', { kind: 'user' }),
      appendMessage(userMessage('u2', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's2', turnId: '2' }),
      loopEvent({ type: 'step.end', uuid: 's2', turnId: '2' }),
    ]);

    expect(result.turnIds).toEqual([0, 1, 2]);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([0, 1, 2]);
    expect(result.turns[1]).toMatchObject({
      input: [{ type: 'text', text: 'cancelled' }],
      origin: { kind: 'user' },
    });
    expect(result.stableTurnIds).toBe(true);
  });

  it('marks an id-less legacy cancel as ambiguous instead of exposing partial stable ids', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      steerTurn('cancelled'),
      appendMessage(userMessage('cancelled', { kind: 'user' })),
      { type: 'turn.cancel' },
      promptTurn('next', { kind: 'user' }),
      appendMessage(userMessage('next', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's2', turnId: '2' }),
      loopEvent({ type: 'step.end', uuid: 's2', turnId: '2' }),
    ]);

    expect(result.stableTurnIds).toBe(false);
  });

  it('does not create a phantom turn for an orphan legacy cancel id', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      { type: 'turn.cancel', turnId: 99 },
      promptTurn('u1', { kind: 'user' }),
      appendMessage(userMessage('u1', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '1' }),
      loopEvent({ type: 'step.end', uuid: 's1', turnId: '1' }),
    ]);

    expect(result.turnIds).toEqual([0, 1]);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([0, 1]);
    expect(result.stableTurnIds).toBe(false);
  });

  it('preserves a queued-turn id gap after its cancel record', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      { type: 'turn.cancel', turnId: 1, target: 'queued' },
      promptTurn('u2', { kind: 'user' }),
      appendMessage(userMessage('u2', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's2', turnId: '2' }),
      loopEvent({ type: 'step.end', uuid: 's2', turnId: '2' }),
    ]);

    expect(result.turnIds).toEqual([0, 2]);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([0, 2]);
    expect(result.stableTurnIds).toBe(true);
  });

  it('keeps an active-turn steer separate from a concurrently cancelled queued turn', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      steerTurn('steered into active'),
      appendMessage(userMessage('steered into active', { kind: 'user' })),
      { type: 'turn.cancel', turnId: 1, target: 'queued' },
      loopEvent({ type: 'step.begin', uuid: 's0-next', turnId: '0' }),
      loopEvent({
        type: 'content.part',
        stepUuid: 's0-next',
        turnId: '0',
        part: { type: 'text', text: 'active answer' },
      }),
      loopEvent({ type: 'step.end', uuid: 's0-next', turnId: '0' }),
      promptTurn('u2', { kind: 'user' }),
      appendMessage(userMessage('u2', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's2', turnId: '2' }),
      loopEvent({ type: 'step.end', uuid: 's2', turnId: '2' }),
    ]);

    expect(result.turnIds).toEqual([0, 0, 0, 2]);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([0, 2]);
    expect(result.stableTurnIds).toBe(true);
  });

  it('marks a legacy cancel ambiguous when a pending steer could belong to another turn', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      steerTurn('pending'),
      appendMessage(userMessage('pending', { kind: 'user' })),
      { type: 'turn.cancel', turnId: 1 },
    ]);

    expect(result.turns.map((turn) => turn.turnId)).toEqual([0]);
    expect(result.stableTurnIds).toBe(false);
  });

  it('marks a cancel id ambiguous when it cannot resolve a pending steer', () => {
    const result = reduceContextTranscript([
      promptTurn('u0', { kind: 'user' }),
      appendMessage(userMessage('u0', { kind: 'user' })),
      loopEvent({ type: 'step.begin', uuid: 's0', turnId: '0' }),
      loopEvent({ type: 'step.end', uuid: 's0', turnId: '0' }),
      steerTurn('pending'),
      appendMessage(userMessage('pending', { kind: 'user' })),
      { type: 'turn.cancel', turnId: 99 },
    ]);

    expect(result.turns.map((turn) => turn.turnId)).toEqual([0]);
    expect(result.stableTurnIds).toBe(false);
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
