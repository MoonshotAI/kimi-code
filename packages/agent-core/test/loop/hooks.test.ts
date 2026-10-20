import { describe, expect, it } from 'vitest';

import { createHistoryMessageBuilder, createUserEntry, type ToolEntry } from '#/history/message';
import { createAssistantMessage, extractText, type Message, type ToolCall } from '#/llm/message';
import type { LlmRequest } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import {
  createLoop,
  type Loop,
  type LoopEmitted,
  type LoopLlmRequester,
  type StepStartingEvent,
  type ToolBatchStartingEvent,
} from '#/loop/index';
import type { ToolExecuteInput } from '#/tool/index';

function requester(outcomes: (() => LlmOutcome)[], onGenerate?: () => void): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (_rest, control) => {
      if (control.signal.aborted) throw new DOMException('aborted', 'AbortError');
      onGenerate?.();
      const next = outcomes.shift();
      if (next === undefined) throw new Error('boom');
      return next();
    },
  };
  return self;
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

describe('step.starting', () => {
  it('fires once per step with the current messages and profile', async () => {
    const tool = { name: 'lookup', description: 'Find things', parameters: { type: 'object', properties: {} } };
    const seen: StepStartingEvent[] = [];
    const scripted = requester([done('', [call('c1', 'lookup')]), done('end')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: { execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }) },
      hooks: [
        {
          point: 'step.starting',
          hook: (event) => {
            seen.push(event);
          },
        },
      ],
    });
    loop.setSystemPrompt('sp');
    loop.setTools([tool]);
    const entry = prompt('hello');
    expect((await loop.runTurn(entry)).type).toBe('done');
    expect(seen.map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [0, 2],
    ]);
    expect(seen[0]?.messages).toEqual([entry]);
    expect(seen[0]?.profile).toEqual({ systemPrompt: 'sp', tools: [tool] });
    expect(seen[1]?.messages.map((item) => item.message.role)).toEqual(['user', 'assistant', 'tool']);
    await loop.close();
  });

  it('also fires for the next step of a resumed turn', async () => {
    const seen: StepStartingEvent[] = [];
    const events: LoopEmitted[] = [];
    const scripted = requester([done('resumed')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: { execute: async () => ({ content: [] }) },
      hooks: [
        {
          point: 'step.starting',
          hook: (event) => {
            seen.push(event);
          },
        },
      ],
      input: {
        messages: [prompt('old')],
        nextTurnId: 1,
        unfinished: { turnId: 0, trigger: 'normal', step: 1, stepUnfinished: true, appended: true },
      },
    });
    loop.subscribe((event) => events.push(event));
    expect(loop.state.status).toBe('interrupted');
    const ended = once(loop, (event) => event.type === 'turn.ended');
    loop.continue();
    await ended;
    expect(events.find((event) => event.type === 'turn.resumed')).toMatchObject({ turnId: 0, step: 1 });
    expect(seen.map((event) => [event.turnId, event.step])).toEqual([[0, 2]]);
    await loop.close();
  });

  it('applies a chained history rewrite to the request and settles it as context', async () => {
    let sent: Message[] = [];
    const capturing: LoopLlmRequester = {
      with: () => capturing,
      request: (part) => part as unknown as LlmRequest,
      generate: async (rest, control) => {
        if (control.signal.aborted) throw new DOMException('aborted', 'AbortError');
        sent = (rest.content as { messages: Message[] }).messages;
        return { type: 'done', message: createAssistantMessage([{ type: 'text', text: 'ok' }]) };
      },
    };
    const rewritten = prompt('rewritten');
    const events: LoopEmitted[] = [];
    const loop = createLoop({
      requester: () => capturing,
      executor: { execute: async () => ({ content: [] }) },
      hooks: [
        {
          point: 'step.starting',
          id: 'compaction',
          hook: (event) => ({ messages: [...event.messages.slice(0, -1), rewritten] }),
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('original'))).type).toBe('done');
    const settled = events.find((event) => event.type === 'context.settled');
    expect(settled).toMatchObject({ messages: [rewritten], reason: 'compaction' });
    expect(sent.map((message) => extractText(message))).toEqual(['rewritten']);
    expect(loop.state.messages[0]).toBe(rewritten);
    await loop.close();
  });

  it('ends the turn blocked at step.starting when a hook blocks', async () => {
    let generates = 0;
    const scripted = requester([done('never')], () => {
      generates += 1;
    });
    const events: LoopEmitted[] = [];
    const loop = createLoop({
      requester: () => scripted,
      executor: { execute: async () => ({ content: [] }) },
      hooks: [{ point: 'step.starting', id: 'guard', hook: () => ({ blocked: { reason: 'no' } }) }],
    });
    loop.subscribe((event) => events.push(event));
    const outcome = await loop.runTurn(prompt('hello'));
    expect(outcome).toEqual({ type: 'blocked', at: 'step.starting', cause: { by: 'guard', reason: 'no' } });
    expect(generates).toBe(0);
    expect(events.find((event) => event.type === 'step.ended')).toMatchObject({
      outcome: { type: 'blocked', at: 'step.starting', cause: { by: 'guard', reason: 'no' } },
    });
    expect(events.find((event) => event.type === 'turn.ended')).toMatchObject({
      outcome: { type: 'blocked', at: 'step.starting', cause: { by: 'guard', reason: 'no' } },
    });
    await loop.close();
  });
});

describe('tool.batch-starting', () => {
  it('settles every call of a denied batch as blocked and continues the turn', async () => {
    const executed: string[] = [];
    const perCall: string[] = [];
    const continuing: number[] = [];
    const stopping: number[] = [];
    const events: LoopEmitted[] = [];
    const scripted = requester([done('', [call('c1', 'alpha'), call('c2', 'beta')]), done('final')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: {
        execute: async ({ toolCall }: ToolExecuteInput) => {
          executed.push(toolCall.name);
          return { content: [] };
        },
      },
      hooks: [
        {
          point: 'tool.batch-starting',
          id: 'swarm',
          hook: () => ({
            blocked: { reason: 'denied' },
            result: { content: [{ type: 'text' as const, text: 'nope' }] },
          }),
        },
        {
          point: 'tool.starting',
          hook: (event) => {
            perCall.push(event.toolCall.id);
          },
        },
        {
          point: 'step.continuing',
          hook: (event) => {
            continuing.push(event.step);
          },
        },
        {
          point: 'step.stopping',
          hook: (event) => {
            stopping.push(event.step);
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(executed).toEqual([]);
    expect(perCall).toEqual([]);
    expect(events.filter((event) => event.type === 'tool.started').map((event) => event.toolCall.id)).toEqual([
      'c1',
      'c2',
    ]);
    const ended = events.filter((event) => event.type === 'tool.ended');
    expect(ended).toHaveLength(2);
    expect(ended[0]).toMatchObject({
      toolCallId: 'c1',
      outcome: { type: 'blocked', cause: { by: 'swarm', reason: 'denied' } },
    });
    expect(ended[1]).toMatchObject({
      toolCallId: 'c2',
      outcome: { type: 'blocked', cause: { by: 'swarm', reason: 'denied' } },
    });
    expect(loop.state.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    const tools = loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(tools.map((entry) => extractText(entry.message))).toEqual(['nope', 'nope']);
    expect(tools.every((entry) => entry.meta?.isError === true)).toBe(true);
    expect(continuing).toEqual([1]);
    expect(stopping).toEqual([2]);
    await loop.close();
  });

  it('lets per-call hooks and the executor run when no hook blocks the batch', async () => {
    const executed: string[] = [];
    const perCall: string[] = [];
    const batches: ToolBatchStartingEvent[] = [];
    const events: LoopEmitted[] = [];
    const scripted = requester([done('', [call('c1', 'alpha'), call('c2', 'beta')]), done('final')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: {
        execute: async ({ toolCall }: ToolExecuteInput) => {
          executed.push(toolCall.name);
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        },
      },
      hooks: [
        {
          point: 'tool.batch-starting',
          hook: (event) => {
            batches.push(event);
          },
        },
        {
          point: 'tool.starting',
          hook: (event) => {
            perCall.push(event.toolCall.id);
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['c1', 'c2']);
    expect(perCall).toEqual(['c1', 'c2']);
    expect(executed).toEqual(['alpha', 'beta']);
    const ended = events.filter((event) => event.type === 'tool.ended');
    expect(ended).toHaveLength(2);
    expect(ended.every((event) => event.outcome.type === 'succeeded')).toBe(true);
    await loop.close();
  });
});

describe('tool.permitting', () => {
  it('runs permitting hooks after all starting hooks regardless of registration order', async () => {
    const order: string[] = [];
    const seen: ToolCall[] = [];
    const executed: ToolCall[] = [];
    const events: LoopEmitted[] = [];
    const rewritten: ToolCall = { type: 'function', id: 'c1', name: 'alpha', arguments: '{"safe":true}' };
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: {
        execute: async ({ toolCall }: ToolExecuteInput) => {
          executed.push(toolCall);
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        },
      },
      hooks: [
        {
          point: 'tool.permitting',
          id: 'permission',
          hook: (event) => {
            order.push('permitting');
            seen.push(event.toolCall);
          },
        },
        {
          point: 'tool.starting',
          id: 'rewrite',
          hook: () => {
            order.push('starting');
            return { toolCall: rewritten };
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(order).toEqual(['starting', 'permitting']);
    expect(seen).toEqual([rewritten]);
    expect(executed).toEqual([rewritten]);
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject({ toolCall: rewritten });
    await loop.close();
  });

  it('skips permitting hooks and the executor when a starting hook blocks', async () => {
    const permitting: string[] = [];
    const executed: string[] = [];
    const events: LoopEmitted[] = [];
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: {
        execute: async ({ toolCall }: ToolExecuteInput) => {
          executed.push(toolCall.name);
          return { content: [] };
        },
      },
      hooks: [
        {
          point: 'tool.starting',
          id: 'guard',
          hook: () => ({ blocked: { reason: 'dirty' } }),
        },
        {
          point: 'tool.permitting',
          hook: (event) => {
            permitting.push(event.toolCall.id);
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(permitting).toEqual([]);
    expect(executed).toEqual([]);
    expect(events.find((event) => event.type === 'tool.ended')).toMatchObject({
      outcome: { type: 'blocked', cause: { by: 'guard', reason: 'dirty' } },
    });
    await loop.close();
  });

  it('settles a permitting block with attribution and lands the result in the history', async () => {
    const executed: string[] = [];
    const events: LoopEmitted[] = [];
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: {
        execute: async ({ toolCall }: ToolExecuteInput) => {
          executed.push(toolCall.name);
          return { content: [] };
        },
      },
      hooks: [
        {
          point: 'tool.permitting',
          id: 'permission',
          hook: () => ({
            blocked: { reason: 'denied' },
            result: { content: [{ type: 'text' as const, text: 'nope' }] },
          }),
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(executed).toEqual([]);
    expect(events.find((event) => event.type === 'tool.ended')).toMatchObject({
      outcome: { type: 'blocked', cause: { by: 'permission', reason: 'denied' } },
    });
    const tools = loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(extractText(tools[0]!.message)).toBe('nope');
    expect(tools[0]?.meta?.isError).toBe(true);
    await loop.close();
  });

  it('reports permitting hook failures under the tool.permitting point', async () => {
    const events: LoopEmitted[] = [];
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: { execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }) },
      hooks: [
        {
          point: 'tool.permitting',
          id: 'flaky-permission',
          hook: () => {
            throw new Error('oops');
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    const failed = events.filter((event) => event.type === 'hook.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ point: 'tool.permitting', hookId: 'flaky-permission', paused: true });
    expect(loop.hooks.list().find((hook) => hook.id === 'flaky-permission')?.paused).toBe(true);
    await loop.close();
  });
});

describe('hook failure policies', () => {
  it('suspends a throwing step.starting hook with the pause policy and continues', async () => {
    let generates = 0;
    const scripted = requester([done('one'), done('two')], () => {
      generates += 1;
    });
    const events: LoopEmitted[] = [];
    const loop = createLoop({
      requester: () => scripted,
      executor: { execute: async () => ({ content: [] }) },
      hooks: [
        {
          point: 'step.starting',
          id: 'flaky',
          onFailure: 'pause',
          hook: () => {
            throw new Error('oops');
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    const followup = once(loop, (event) => event.type === 'turn.ended' && event.turnId === 1);
    expect((await loop.runTurn(prompt('hello'))).type).toBe('done');
    await followup;
    const failed = events.filter((event) => event.type === 'hook.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ point: 'step.starting', hookId: 'flaky', paused: true });
    expect(loop.hooks.list().find((hook) => hook.id === 'flaky')?.paused).toBe(true);
    expect(generates).toBe(2);
    await loop.close();
  });

  it('converts a throwing step.starting hook with the block policy into a blocked turn', async () => {
    let thrown = false;
    const scripted = requester([done('after')]);
    const events: LoopEmitted[] = [];
    const loop = createLoop({
      requester: () => scripted,
      executor: { execute: async () => ({ content: [] }) },
      hooks: [
        {
          point: 'step.starting',
          id: 'strict',
          onFailure: 'block',
          hook: () => {
            if (thrown) return;
            thrown = true;
            throw new Error('nope');
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    const followup = once(loop, (event) => event.type === 'turn.ended' && event.turnId === 1);
    const outcome = await loop.runTurn(prompt('hello'));
    expect(outcome).toEqual({
      type: 'blocked',
      at: 'step.starting',
      cause: { by: 'strict', reason: 'hook_failed', message: '[hook failed] step.starting: nope' },
    });
    await followup;
    const failed = events.filter((event) => event.type === 'hook.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ point: 'step.starting', hookId: 'strict', paused: false });
    await loop.close();
  });

  it('applies a tool.batch-starting block-policy failure to every call', async () => {
    const executed: string[] = [];
    const events: LoopEmitted[] = [];
    const scripted = requester([done('', [call('c1', 'alpha'), call('c2', 'beta')]), done('final')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: {
        execute: async ({ toolCall }: ToolExecuteInput) => {
          executed.push(toolCall.name);
          return { content: [] };
        },
      },
      hooks: [
        {
          point: 'tool.batch-starting',
          id: 'batch-strict',
          onFailure: 'block',
          hook: () => {
            throw new Error('bang');
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(executed).toEqual([]);
    const ended = events.filter((event) => event.type === 'tool.ended');
    expect(ended).toHaveLength(2);
    for (const event of ended) {
      expect(event).toMatchObject({
        outcome: { type: 'blocked', cause: { by: 'batch-strict', reason: 'hook_failed' } },
      });
    }
    const tools = loop.state.messages.filter((entry) => entry.message.role === 'tool');
    expect(tools.map((entry) => extractText(entry.message))).toEqual([
      '[hook failed] tool.batch-starting: bang',
      '[hook failed] tool.batch-starting: bang',
    ]);
    await loop.close();
  });
});
