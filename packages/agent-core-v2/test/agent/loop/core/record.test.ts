import { describe, expect, it } from 'vitest';

import { createUserMessage, extractText, type ToolCall } from '@moonshot-ai/core/llm/message';
import type { LoopToolExecutor } from '@moonshot-ai/core/loop/create-loop';
import {
  loopProjection,
  toLoopRecord,
  type Loop,
  type LoopEmitted,
  type FullLoopLlmRequester,
  type LoopRecord,
} from '@moonshot-ai/core/loop/index';
import { createMockProviderRequester, type MockProviderResponse } from '../../../harness/scripted-generate';
import { createTestLoop as createLoop } from './factory';
import { textToolContent, type ToolReturn } from '#/tool/executor';
import { executorFrom, successfulExecutor } from './executor';

function requester(responses: MockProviderResponse[]): FullLoopLlmRequester {
  return createMockProviderRequester(() => {
    const next = responses.shift();
    if (next === undefined) throw new Error('boom');
    return next;
  });
}

function record(loop: Loop): LoopRecord[] {
  const records: LoopRecord[] = [];
  loop.subscribe((event) => {
    const converted = toLoopRecord(event);
    if (converted !== undefined) records.push(converted);
  });
  return records;
}

function fold(records: readonly LoopRecord[]) {
  const projection = loopProjection();
  return records.reduce(
    (current, event, seq) => projection.reduce(current, { seq, time: 0, event }),
    projection.initial(),
  );
}

function once(loop: Loop, match: (event: LoopEmitted) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stop = loop.subscribe((event) => {
      if (!match(event)) return;
      stop();
      resolve();
    });
  });
}

const prompt = (text: string) => createUserMessage(text);
const done = (text: string, toolCalls: ToolCall[] = []): MockProviderResponse => ({
  parts: [{ type: 'text', text }, ...toolCalls],
});
const call = (id: string, name: string): ToolCall => ({ type: 'function', id, name, arguments: '{}' });

describe('loop record', () => {
  it('folds durable loop events back into the loop history and recovers interrupted turns', async () => {
    const scripted = requester([done('hi')]);
    const loop = createLoop({
      requester: scripted,
      executor: successfulExecutor(['lookup', 'bg', 'slow'], ''),
    });
    const records = record(loop);
    expect((await loop.runTurn(prompt('hello'))).type).toBe('done');
    expect((await loop.runTurn(prompt('again'))).type).toBe('failed');
    const types = records.map((item) => item.type);
    expect(types).not.toContain('llm.delta.part');
    expect(types).not.toContain('prompt.submitted');
    const ended = records.findLast((item) => item.type === 'turn.ended');
    expect(ended).toMatchObject({ outcome: { type: 'failed', error: { message: 'boom' } } });
    const state = fold(records);
    expect(state.messages).toEqual(loop.state.messages);
    expect(state.nextTurnId).toBe(loop.state.nextTurnId);
    expect(state.unfinished).toBeUndefined();
    expect(state.turns.map((turn) => [turn.turnId, turn.outcome?.type])).toEqual([
      [0, 'done'],
      [1, 'failed'],
    ]);
    const restored = createLoop({
      requester: requester([]),
      executor: successfulExecutor(['lookup', 'bg', 'slow'], ''),
      input: { messages: state.messages, nextTurnId: state.nextTurnId },
    });
    expect(restored.state.messages).toEqual(loop.state.messages);

    let settleBackground: ((result: ToolReturn) => void) | undefined;
    let settleSlow: ((result: ToolReturn) => void) | undefined;
    const executor = executorFrom(['bg', 'slow'], (context) => {
        if (context.call.name === 'bg') {
          context.onDetach(() => ({ content: textToolContent('bg ack') }));
          context.detach('bg ack');
          return new Promise<ToolReturn>((resolve) => {
            settleBackground = resolve;
          });
        }
        return new Promise<ToolReturn>((resolve) => {
          settleSlow = resolve;
        });
      },
    );
    const acting = requester([done('', [call('call-slow', 'slow'), call('call-bg', 'bg')])]);
    const working = createLoop({
      requester: acting,
      executor,
      input: { messages: state.messages, nextTurnId: state.nextTurnId },
    });
    const live = record(working);
    const detached = once(working, (event) => event.type === 'tool.ended' && event.detached);
    working.submit(prompt('work'));
    await detached;
    const prefix = [...records, ...live];
    const crashed = fold(prefix);
    expect(crashed.unfinished).toEqual({ turnId: 2, trigger: 'normal', step: 1, stepUnfinished: true, appended: true });
    expect(crashed.nextTurnId).toBe(3);

    const turnEndEvents: Extract<LoopEmitted, { type: 'turn.ended' }>[] = [];
    working.subscribe((event) => {
      if (event.type === 'turn.ended') turnEndEvents.push(event);
    });
    let closingIdle: Promise<void> | undefined;
    let closes: { first: Promise<void>; second: Promise<void> } | undefined;
    const stop = working.subscribe((event) => {
      if (event.type !== 'prompt.reminded') return;
      stop();
      closingIdle = working.waitForIdle();
      closes = { first: working.close(), second: working.close() };
    });
    working.remind(prompt('reentrant close'));
    const { first, second } = closes!;
    expect(second).toBe(first);
    settleSlow?.({ content: [{ type: 'text', text: 'slow stopped' }] });
    settleBackground?.({ content: [{ type: 'text', text: 'background stopped' }] });
    await first;
    await closingIdle;
    expect(turnEndEvents.every((ended) => ended.continuation === undefined)).toBe(true);
    const closed = fold([...records, ...live]);
    expect(closed.unfinished).toBeUndefined();
    expect(closed.turns.at(-1)).toMatchObject({ turnId: 2, outcome: { type: 'aborted', reason: { reason: 'closed' } } });
    expect(closed.messages.slice(-3).map((entry) => entry.role)).toEqual(['tool', 'tool', 'user']);
    expect(extractText(closed.messages.at(-1)!)).toBe('reentrant close');
    expect(closed.notify.map((entry) => extractText(entry))).toEqual([
      '[async tool aborted] bg (tool_call_id=call-bg)',
    ]);
    const recordsAtClose = live.length;
    settleBackground?.({ content: [{ type: 'text', text: 'late' }] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(live).toHaveLength(recordsAtClose);

    const answering = requester([done('next')]);
    const recovered = createLoop({
      requester: answering,
      executor,
      input: {
        messages: crashed.messages,
        nextTurnId: crashed.nextTurnId,
        unfinished: crashed.unfinished,
      },
    });
    expect(recovered.state).toMatchObject({ status: 'interrupted', turn: { id: 2, step: 1 } });
    const recoveredEnds: Extract<LoopEmitted, { type: 'turn.ended' }>[] = [];
    recovered.subscribe((event) => {
      if (event.type === 'turn.ended') recoveredEnds.push(event);
    });
    const after = record(recovered);
    expect((await recovered.runTurn(prompt('next'))).type).toBe('done');
    expect(after.slice(0, 7).map((item) => item.type)).toEqual([
      'tool.ended',
      'message.appended',
      'tool.ended',
      'message.appended',
      'step.ended',
      'turn.ended',
      'turn.started',
    ]);
    expect(after[4]).toMatchObject({ turnId: 2, outcome: { type: 'aborted', reason: { reason: 'crashed' } } });
    expect(after[6]).toMatchObject({ type: 'turn.started' });
    await recovered.waitForIdle();
    expect(recoveredEnds.map((ended) => [ended.turnId, ended.continuation])).toEqual([
      [2, 'turn'],
      [3, 'none'],
    ]);
    const resumed = fold([...prefix, ...after]);
    expect(resumed.unfinished).toBeUndefined();
    expect(resumed.nextTurnId).toBe(4);
    expect(resumed.messages).toEqual(recovered.state.messages);
    expect(resumed.turns.map((turn) => [turn.turnId, turn.outcome?.type])).toEqual([
      [0, 'done'],
      [1, 'failed'],
      [2, 'aborted'],
      [3, 'done'],
    ]);
  });

  it('force abort settles only unfinished foreground tool calls and ignores late results', async () => {
    let settleStuck!: (result: ToolReturn) => void;
    let stuckCompletion: Promise<unknown> | undefined;
    const delegated = executorFrom(['fast', 'stuck'], (context) => {
      if (context.call.name === 'fast') {
        return Promise.resolve({ content: textToolContent('fast ok') });
      }
      return new Promise<ToolReturn>((resolve) => {
        settleStuck = resolve;
      });
    });
    const executor: LoopToolExecutor = {
      execute: (toolCall, context) => {
        const handler = delegated.execute(toolCall, context);
        if (toolCall.name === 'stuck') stuckCompletion = handler.wait();
        return handler;
      },
    };
    const loop = createLoop({
      requester: requester([done('', [call('call-fast', 'fast'), call('call-stuck', 'stuck')])]),
      executor,
    });
    const events: LoopEmitted[] = [];
    loop.subscribe((event) => events.push(event));
    const fastEnded = once(loop, (event) => event.type === 'tool.ended' && event.toolCallId === 'call-fast');
    const stuckStarted = once(loop, (event) => event.type === 'tool.started' && event.toolCall.id === 'call-stuck');
    const running = loop.runTurn(prompt('work'));
    await Promise.all([fastEnded, stuckStarted]);

    loop.abort('graceful');
    loop.abort('force');

    await expect(running).resolves.toMatchObject({ type: 'aborted', reason: 'graceful' });
    await loop.waitForIdle();
    expect(events.filter((event) => event.type === 'tool.ended' && event.toolCallId === 'call-fast')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.ended' && event.toolCallId === 'call-stuck')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.ended' && event.toolCallId === 'call-fast')).toMatchObject({
      outcome: { type: 'succeeded' },
    });
    expect(events.find((event) => event.type === 'tool.ended' && event.toolCallId === 'call-stuck')).toMatchObject({
      outcome: { type: 'aborted', reason: 'graceful' },
    });
    expect(events.filter((event) => event.type === 'turn.ended')).toHaveLength(1);
    const toolMessages = loop.state.messages.filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => extractText(message))).toEqual(['fast ok', 'Tool "stuck" was aborted']);

    const terminalEventCount = events.filter((event) =>
      event.type === 'tool.started' ||
      event.type === 'tool.ended' ||
      event.type === 'message.appended' ||
      event.type === 'step.ended' ||
      event.type === 'turn.ended'
    ).length;
    settleStuck({ content: textToolContent('late result') });
    await stuckCompletion;
    await Promise.resolve();
    expect(events.filter((event) =>
      event.type === 'tool.started' ||
      event.type === 'tool.ended' ||
      event.type === 'message.appended' ||
      event.type === 'step.ended' ||
      event.type === 'turn.ended'
    )).toHaveLength(terminalEventCount);
    await loop.close();
  });
});
