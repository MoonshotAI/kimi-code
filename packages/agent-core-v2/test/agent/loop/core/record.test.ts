import { describe, expect, it } from 'vitest';

import { createUserEntry } from '#human/agent/turn';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '#human/llm/message';
import type { LlmRequest } from '#human/llm/request';
import type { LlmOutcome } from '#human/llm/response';
import {
  loopProjection,
  toLoopRecord,
  type Loop,
  type LoopEmitted,
  type LoopLlmRequester,
  type LoopRecord,
} from '#/agent/loop/core/index';
import { createTestLoop as createLoop } from './factory';
import type { ToolExecuteInput, ToolResult } from '#human/tool/executor';
import { executorFrom, successfulExecutor } from './executor';

function requester(outcomes: (() => LlmOutcome)[]): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (_rest, control) => {
      const next = outcomes.shift();
      if (next === undefined) throw new Error('boom');
      const outcome = next();
      control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'hi' } });
      return outcome;
    },
  };
  return self;
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

const prompt = (text: string) => createUserEntry(createUserMessage(text));
const done = (text: string, toolCalls: ToolCall[] = []): (() => LlmOutcome) => () => ({
  type: 'done',
  message: createAssistantMessage([{ type: 'text', text }], toolCalls),
});
const call = (id: string, name: string): ToolCall => ({ type: 'function', id, name, arguments: '{}' });

describe('loop record', () => {
  it('folds durable loop events back into the loop history and recovers interrupted turns', async () => {
    const scripted = requester([done('hi')]);
    const loop = createLoop({
      createTurnExecution: ({ profile }) => ({ profile, requester: scripted }),
      executor: successfulExecutor(['lookup', 'bg', 'slow'], ''),
    });
    const records = record(loop);
    expect((await loop.runTurn(prompt('hello'))).type).toBe('done');
    expect((await loop.runTurn(prompt('again'))).type).toBe('failed');
    const types = records.map((item) => item.type);
    expect(types).not.toContain('llm.streaming.part');
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
      createTurnExecution: ({ profile }) => ({ profile, requester: requester([]) }),
      executor: successfulExecutor(['lookup', 'bg', 'slow'], ''),
      input: { messages: state.messages, nextTurnId: state.nextTurnId },
    });
    expect(restored.state.messages).toEqual(loop.state.messages);

    let settleBackground: ((result: ToolResult) => void) | undefined;
    let settleSlow: ((result: ToolResult) => void) | undefined;
    const executor = executorFrom(['bg', 'slow'], ({ toolCall, detach }: ToolExecuteInput) => {
        if (toolCall.name === 'bg') {
          detach?.('bg ack');
          return new Promise<ToolResult>((resolve) => {
            settleBackground = resolve;
          });
        }
        return new Promise<ToolResult>((resolve) => {
          settleSlow = resolve;
        });
      },
    );
    const acting = requester([done('', [call('call-slow', 'slow'), call('call-bg', 'bg')])]);
    const working = createLoop({
      createTurnExecution: ({ profile }) => ({ profile, requester: acting }),
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

    let closes: { first: Promise<void>; second: Promise<void> } | undefined;
    const stop = working.subscribe((event) => {
      if (event.type !== 'prompt.reminded') return;
      stop();
      closes = { first: working.close(), second: working.close() };
    });
    working.remind(prompt('reentrant close'));
    const { first, second } = closes!;
    expect(second).toBe(first);
    settleSlow?.({ content: [{ type: 'text', text: 'slow stopped' }] });
    settleBackground?.({ content: [{ type: 'text', text: 'background stopped' }] });
    await first;
    const closed = fold([...records, ...live]);
    expect(closed.unfinished).toBeUndefined();
    expect(closed.turns.at(-1)).toMatchObject({ turnId: 2, outcome: { type: 'aborted', reason: { reason: 'closed' } } });
    expect(closed.messages.slice(-3).map((entry) => entry.message.role)).toEqual(['tool', 'tool', 'user']);
    expect(extractText(closed.messages.at(-1)!.message)).toBe('reentrant close');
    expect(closed.notify.map((entry) => extractText(entry.message))).toEqual([
      '[async tool aborted] bg (tool_call_id=call-bg)',
    ]);
    const recordsAtClose = live.length;
    settleBackground?.({ content: [{ type: 'text', text: 'late' }] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(live).toHaveLength(recordsAtClose);

    const answering = requester([done('next')]);
    const recovered = createLoop({
      createTurnExecution: ({ profile }) => ({ profile, requester: answering }),
      executor,
      input: { messages: crashed.messages, nextTurnId: crashed.nextTurnId, unfinished: crashed.unfinished },
    });
    expect(recovered.state).toMatchObject({ status: 'interrupted', turn: { id: 2, step: 1 } });
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
});
