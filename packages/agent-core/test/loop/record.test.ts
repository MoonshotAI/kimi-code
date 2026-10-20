import { describe, expect, it } from 'vitest';

import { createHistoryMessageBuilder, createUserEntry } from '#/history/message';
import { createAssistantMessage, extractText, type ToolCall } from '#/llm/message';
import type { LlmRequest } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import {
  createLoop,
  loopProjection,
  toLoopRecord,
  type Loop,
  type LoopEmitted,
  type LoopLlmRequester,
  type LoopRecord,
} from '#/loop/index';
import type { ToolExecuteInput, ToolResult } from '#/tool/index';

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

const prompt = (text: string) => createUserEntry(createHistoryMessageBuilder().plain(text).userMessage());
const done = (text: string, toolCalls: ToolCall[] = []): (() => LlmOutcome) => () => ({
  type: 'done',
  message: createAssistantMessage([{ type: 'text', text }], toolCalls),
});
const call = (id: string, name: string): ToolCall => ({ type: 'function', id, name, arguments: '{}' });

describe('loop record', () => {
  it('folds durable loop events back into the loop history and recovers interrupted turns', async () => {
    const scripted = requester([done('hi')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: { execute: async () => ({ content: [] }) },
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
      requester: () => requester([]),
      executor: { execute: async () => ({ content: [] }) },
      input: { messages: state.messages, nextTurnId: state.nextTurnId },
    });
    expect(restored.state.messages).toEqual(loop.state.messages);

    const executor = {
      execute: ({ toolCall, detach }: ToolExecuteInput) => {
        if (toolCall.name === 'bg') detach?.('bg ack');
        return new Promise<ToolResult>(() => {});
      },
    };
    const acting = requester([done('', [call('call-slow', 'slow'), call('call-bg', 'bg')])]);
    const working = createLoop({
      requester: () => acting,
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

    await working.close();
    const closed = fold([...records, ...live]);
    expect(closed.unfinished).toBeUndefined();
    expect(closed.turns.at(-1)).toMatchObject({ turnId: 2, outcome: { type: 'aborted', reason: { reason: 'closed' } } });
    expect(closed.messages.slice(-2).map((entry) => entry.message.role)).toEqual(['tool', 'tool']);
    expect(closed.notify.map((entry) => extractText(entry.message))).toEqual([
      '[async tool aborted] bg (tool_call_id=call-bg)',
    ]);

    const answering = requester([done('next')]);
    const recovered = createLoop({
      requester: () => answering,
      executor,
      input: { messages: crashed.messages, nextTurnId: crashed.nextTurnId, unfinished: crashed.unfinished },
    });
    expect(recovered.state).toMatchObject({ status: 'interrupted', turn: { id: 2, step: 1 } });
    const after = record(recovered);
    expect((await recovered.runTurn(prompt('next'))).type).toBe('done');
    expect(after.slice(0, 5).map((item) => item.type)).toEqual([
      'message.appended',
      'message.appended',
      'step.ended',
      'turn.ended',
      'turn.started',
    ]);
    expect(after[3]).toMatchObject({ turnId: 2, outcome: { type: 'aborted', reason: { reason: 'crashed' } } });
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

  it('settles the loop profile into durable records and restores it on replay', async () => {
    let sent: unknown;
    const capturing: LoopLlmRequester = {
      with: () => capturing,
      request: (part) => part as unknown as LlmRequest,
      generate: async (rest) => {
        sent = rest;
        return { type: 'done', message: createAssistantMessage([{ type: 'text', text: 'ok' }]) };
      },
    };
    const executor = { execute: async () => ({ content: [] }) };
    const loop = createLoop({ requester: () => capturing, executor });
    const records = record(loop);
    const tool = { name: 'lookup', description: 'Find things', parameters: { type: 'object', properties: {} } };

    expect(loop.setSystemPrompt('you are helpful')?.type).toBe('system_prompt.settled');
    expect(loop.setTools([tool])?.type).toBe('tools.settled');
    expect(loop.state.profile).toEqual({ systemPrompt: 'you are helpful', tools: [tool] });

    expect((await loop.runTurn(prompt('hello'))).type).toBe('done');
    expect(sent).toMatchObject({ profile: { systemPrompt: 'you are helpful', tools: [tool] } });

    expect(loop.setSystemPrompt('v2')?.type).toBe('system_prompt.settled');
    expect(loop.setSystemPrompt()?.type).toBe('system_prompt.settled');
    expect(loop.setTools([])?.type).toBe('tools.settled');
    expect(loop.state.profile).toEqual({ tools: [] });

    const settled = records.map((item) => item.type).filter((type) => type.endsWith('.settled'));
    expect(settled).toEqual([
      'system_prompt.settled',
      'tools.settled',
      'system_prompt.settled',
      'system_prompt.settled',
      'tools.settled',
    ]);
    const state = fold(records);
    expect(state.profile).toEqual({ tools: [] });

    const restored = createLoop({
      requester: () => capturing,
      executor,
      input: { messages: state.messages, nextTurnId: state.nextTurnId, profile: { systemPrompt: 'restored', tools: [tool] } },
    });
    expect(restored.state.profile).toEqual({ systemPrompt: 'restored', tools: [tool] });

    const stuck = createLoop({
      requester: () => capturing,
      executor,
      input: {
        messages: [prompt('stuck')],
        nextTurnId: 1,
        unfinished: { turnId: 0, trigger: 'normal', step: 0, stepUnfinished: false, appended: true },
      },
    });
    expect(stuck.state.status).toBe('interrupted');
    expect(stuck.setSystemPrompt('nope')?.type).toBe('system_prompt.rejected');
    expect(stuck.setTools([tool])?.type).toBe('tools.rejected');
    expect(stuck.state.profile).toEqual({});

    await Promise.all([loop.close(), restored.close(), stuck.close()]);
  });
});
