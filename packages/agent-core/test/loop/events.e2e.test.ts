/**
 * LoopEventDispatcher live event contract — fire-and-forget listener errors must
 * never reach the loop.
 */

import { describe, expect, it } from 'vitest';

import type { LoopEvent, LoopLiveEventEmitter } from '../../src/loop/index';
import { CollectingSink } from './fixtures/collecting-sink';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import { EchoTool, markReadFileAccesses, ProgressTool } from './fixtures/tools';

describe('runTurn — LoopEventDispatcher live event containment', () => {
  it('contains synchronous emit() throws', async () => {
    const sink = new CollectingSink({ errorMode: { kind: 'sync-throw' } });
    const { result } = await runTurn({
      emitLiveEvent: sink.emit,
      responses: [makeEndTurnResponse('ok')],
    });
    // The loop still completes the turn.
    expect(result.stopReason).toBe('end_turn');
  });

  it('contains async-rejected emit() returns', async () => {
    const sink = new CollectingSink({ errorMode: { kind: 'async-reject' } });
    const { result } = await runTurn({
      emitLiveEvent: sink.emit,
      responses: [makeEndTurnResponse('ok')],
    });
    expect(result.stopReason).toBe('end_turn');
    // Each emit is recorded even though the listener returned a rejected
    // promise; LoopEventDispatcher attaches a terminal catch.
    expect(sink.events.length).toBeGreaterThanOrEqual(2);
  });

  it('survives a sink that throws on EVERY emit across a full multi-step turn', async () => {
    const sink = new CollectingSink({ errorMode: { kind: 'every-call-throws' } });
    const echo = new EchoTool();
    const progress = new ProgressTool();
    const { result, context } = await runTurn({
      emitLiveEvent: sink.emit,
      tools: [echo, progress],
      responses: [
        makeToolUseResponse([
          makeToolCall('echo', { text: '1' }, 'a'),
          makeToolCall('progress', {}, 'b'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });
    // Despite every emit throwing, the turn still converges and writes
    // its transcript records.
    expect(result.stopReason).toBe('end_turn');
    expect(context.stepBegins().length).toBe(2);
    expect(context.stepEnds().length).toBe(2);
    // The tool was still executed
    expect(echo.calls.length).toBe(1);
    expect(progress.calls.length).toBe(1);
  });

  it('allows host-owned fan-out through a single emitter function', async () => {
    const a = new CollectingSink({ id: 'a' });
    const b = new CollectingSink({ id: 'b' });
    const { result } = await runTurn({
      emitLiveEvent: (event) => {
        a.emit(event);
        b.emit(event);
      },
      responses: [makeEndTurnResponse('ok')],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(a.typesIn()).toEqual(b.typesIn());
    expect(a.events.length).toBeGreaterThan(0);
  });

  it('a misbehaving sink does not starve the others', async () => {
    const broken = new CollectingSink({
      id: 'broken',
      errorMode: { kind: 'every-call-throws' },
    });
    const good = new CollectingSink({ id: 'good' });
    const { result } = await runTurn({
      emitLiveEvent: (event) => {
        try {
          broken.emit(event);
        } catch {
          // host-owned fan-out contains individual listener failure
        }
        good.emit(event);
      },
      responses: [makeEndTurnResponse('ok')],
    });
    expect(result.stopReason).toBe('end_turn');
    // Good sink received the events; ordering matches the documented set.
    expect(good.count('step.begin')).toBe(1);
    expect(good.count('step.end')).toBe(1);
  });

  it('emits a documented full event sequence for one tool-bearing turn', async () => {
    const echo = markReadFileAccesses(new EchoTool());
    const progress = markReadFileAccesses(
      new ProgressTool([{ kind: 'progress', percent: 50 }]),
    );
    const { sink } = await runTurn({
      tools: [echo, progress],
      responses: [
        makeToolUseResponse([
          makeToolCall('echo', { text: 'hi' }, 'tc-1'),
          makeToolCall('progress', {}, 'tc-2'),
        ]),
        makeEndTurnResponse('done', { inputOther: 1, output: 1 }),
      ],
    });

    const types = sink.typesIn();
    // Required milestones in order
    const order: LoopEvent['type'][] = [
      'step.begin',
      'tool.call',
      'tool.call',
      'tool.result',
      'tool.result',
      'step.end',
      'step.begin',
      'step.end',
    ];
    // Every required type appears in the right relative order
    let fromIdx = 0;
    for (const expected of order) {
      const found = types.indexOf(expected, fromIdx);
      expect(
        found,
        `missing ${expected} starting at ${String(fromIdx)} of [${types.join(',')}]`,
      ).toBeGreaterThanOrEqual(fromIdx);
      fromIdx = found + 1;
    }
    // tool.progress fired between tool.call and tool.result
    expect(sink.byType('tool.progress').length).toBe(1);
  });

  it('LoopEvent payload carries the documented fields', async () => {
    const echo = new EchoTool();
    const { sink } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-99')]),
        makeEndTurnResponse('done'),
      ],
    });
    const tc = sink.byType('tool.call')[0];
    expect(tc).toBeDefined();
    expect(tc?.toolCallId).toBe('tc-99');
    expect(tc?.name).toBe('echo');
    expect(tc?.args).toEqual({ text: 'hi' });
    const tr = sink.byType('tool.result')[0];
    expect(tr?.toolCallId).toBe('tc-99');
    expect(typeof tr?.result.output).toBe('string');
  });

  it('accepts a custom emitter function', async () => {
    class StrictCollector {
      readonly events: LoopEvent[] = [];
      readonly emit: LoopLiveEventEmitter = (event) => {
        this.events.push(event);
      };
    }
    const custom = new StrictCollector();
    const { result } = await runTurn({
      emitLiveEvent: custom.emit,
      responses: [makeEndTurnResponse('ok')],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(custom.events.length).toBeGreaterThan(0);
  });
});
