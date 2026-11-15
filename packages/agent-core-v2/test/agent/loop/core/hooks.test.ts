import { describe, expect, it } from 'vitest';

import { createUserMessage, extractText, type Message, type ToolCall, type ToolMessage } from '@moonshot-ai/core/llm/message';
import type {
  Loop,
  LoopEmitted,
  LoopLlmRequester,
  StepStartingEvent,
  ToolBatchStartingEvent,
} from '@moonshot-ai/core/loop/index';
import { createMockProviderRequester, type MockProviderResponse } from '../../../harness/scripted-generate';
import { createTestLoop as createLoop } from './factory';
import type {
  ToolExecuteInput,
  ToolHookRegistration,
  ToolResult,
} from '@moonshot-ai/core/tool/executor';
import { executorFrom, successfulExecutor } from './executor';

function requester(responses: MockProviderResponse[], onGenerate?: () => void): LoopLlmRequester {
  return createMockProviderRequester(() => {
    onGenerate?.();
    const next = responses.shift();
    if (next === undefined) throw new Error('boom');
    return next;
  });
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

describe('step.starting', () => {
  it('fires once per step with the current messages and profile', async () => {
    const tool = { name: 'lookup', description: 'Find things', parameters: { type: 'object', properties: {} } };
    const seen: StepStartingEvent[] = [];
    const scripted = requester([done('', [call('c1', 'lookup')]), done('end')]);
    const loop = createLoop({
      requester: scripted,
      executor: successfulExecutor(['lookup']),
      input: { profile: { tools: [tool] } },
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
    const entry = prompt('hello');
    expect((await loop.runTurn(entry)).type).toBe('done');
    expect(seen.map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [0, 2],
    ]);
    expect(seen[0]?.messages).toEqual([entry]);
    expect(seen[0]?.profile).toEqual({ systemPrompt: 'sp', tools: [tool] });
    expect(seen[1]?.messages.map((item) => item.role)).toEqual(['user', 'assistant', 'tool']);
    await loop.close();
  });

  it('also fires for the next step of a resumed turn', async () => {
    const seen: StepStartingEvent[] = [];
    const events: LoopEmitted[] = [];
    const scripted = requester([done('resumed')]);
    const loop = createLoop({
      requester: scripted,
      executor: successfulExecutor(['lookup', 'alpha', 'beta', 'work'], ''),
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

  it('applies history rewrites during step start and an in-flight request', async () => {
    let sent: Message[] = [];
    const capturing = createMockProviderRequester((request) => {
      sent = [...request.content.messages];
      return done('ok');
    });
    const rewritten = prompt('rewritten');
    const events: LoopEmitted[] = [];
    const loop = createLoop({
      requester: capturing,
      executor: successfulExecutor(['lookup', 'alpha', 'beta', 'work'], ''),
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

    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    let finishRequest!: () => void;
    const finish = new Promise<void>((resolve) => { finishRequest = resolve; });
    const pending = createMockProviderRequester(async () => {
      requestStarted();
      await finish;
      return done('late answer');
    });
    const active = createLoop({ requester: pending, executor: successfulExecutor(['lookup', 'alpha', 'beta', 'work'], '') });
    const running = active.runTurn(prompt('stale context'));
    await started;
    expect(active.setContext([], 'clear')?.type).toBe('context.settled');
    expect(active.state.messages).toEqual([]);
    finishRequest();
    expect((await running).type).toBe('done');
    expect(active.state.messages.map((entry) => extractText(entry))).toEqual(['late answer']);
    await active.close();
  });

  it('ends the turn blocked at step.starting when a hook blocks', async () => {
    let generates = 0;
    const scripted = requester([done('never')], () => {
      generates += 1;
    });
    const events: LoopEmitted[] = [];
    const loop = createLoop({
      requester: scripted,
      executor: successfulExecutor(['lookup', 'alpha', 'beta', 'work'], ''),
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

function createExecutor(
  registrations: readonly ToolHookRegistration[],
  execute: (input: ToolExecuteInput) => Promise<ToolResult> = async () => ({ content: [] }),
) {
  return executorFrom(['alpha', 'beta'], execute, registrations);
}

describe('tool.batch-starting', () => {
  it('settles every call of a denied batch as blocked and continues the turn', async () => {
    const executed: string[] = [];
    const perCall: string[] = [];
    const continuing: number[] = [];
    const stopping: number[] = [];
    const events: LoopEmitted[] = [];
    const tools = createExecutor(
      [
        {
          point: 'tool.starting',
          hook: (event) => {
            perCall.push(event.toolCall.id);
          },
        },
      ],
      async ({ toolCall }) => {
        executed.push(toolCall.name);
        return { content: [] };
      },
    );
    const scripted = requester([done('', [call('c1', 'alpha'), call('c2', 'beta')]), done('final')]);
    const loop = createLoop({
      requester: scripted,
      executor: tools,
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
    expect(loop.state.messages.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    const entries = loop.state.messages.filter((entry): entry is ToolMessage => entry.role === 'tool');
    expect(entries.map((entry) => extractText(entry))).toEqual(['nope', 'nope']);
    expect(entries.every((entry) => entry.attributes?.isError === true)).toBe(true);
    expect(continuing).toEqual([1]);
    expect(stopping).toEqual([1, 2]);
    await loop.close();
  });

  it('lets per-call hooks and the executor run when no hook blocks the batch', async () => {
    const executed: string[] = [];
    const perCall: string[] = [];
    const batches: ToolBatchStartingEvent[] = [];
    const events: LoopEmitted[] = [];
    const tools = createExecutor(
      [
        {
          point: 'tool.starting',
          hook: (event) => {
            perCall.push(event.toolCall.id);
          },
        },
      ],
      async ({ toolCall }) => {
        executed.push(toolCall.name);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    );
    const scripted = requester([done('', [call('c1', 'alpha'), call('c2', 'beta')]), done('final')]);
    const loop = createLoop({
      requester: scripted,
      executor: tools,
      hooks: [
        {
          point: 'tool.batch-starting',
          hook: (event) => {
            batches.push(event);
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
  it('runs permitting after starting and executes the rewritten call without native stopTurn', async () => {
    const order: string[] = [];
    const seen: ToolCall[] = [];
    const executed: ToolCall[] = [];
    const events: LoopEmitted[] = [];
    const rewritten: ToolCall = { type: 'function', id: 'c1', name: 'alpha', arguments: '{"safe":true}' };
    const tools = createExecutor(
      [
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
      async ({ toolCall }) => {
        executed.push(toolCall);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    );
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({ requester: scripted, executor: tools });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(order).toEqual(['starting', 'permitting']);
    expect(seen).toEqual([rewritten]);
    expect(executed).toEqual([rewritten]);
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject({
      toolCall: { ...rewritten, arguments: '{}' },
      args: { safe: true },
    });
    expect(events.find((event) => event.type === 'tool.ended')).toMatchObject({
      outcome: { type: 'succeeded' },
    });
    await loop.close();
  });

  it('skips permitting and execution on a starting block without stopping the next step', async () => {
    const permitting: string[] = [];
    const executed: string[] = [];
    const events: LoopEmitted[] = [];
    const tools = createExecutor(
      [
        {
          point: 'tool.starting',
          id: 'guard',
          hook: () => ({
            blocked: { reason: 'dirty' },
            result: { content: [{ type: 'text' as const, text: 'nope' }] },
          }),
        },
        {
          point: 'tool.permitting',
          hook: (event) => {
            permitting.push(event.toolCall.id);
          },
        },
      ],
      async ({ toolCall }) => {
        executed.push(toolCall.name);
        return { content: [] };
      },
    );
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({ requester: scripted, executor: tools });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(permitting).toEqual([]);
    expect(executed).toEqual([]);
    expect(events.find((event) => event.type === 'tool.ended')).toMatchObject({
      outcome: {
        type: 'failed',
        message: { attributes: { isError: true } },
      },
    });
    await loop.close();
  });


 it('skips the permitting phase when a starting hook returns skipPermitting', async () => {
    const permitting: string[] = [];
    const executed: string[] = [];
    const events: LoopEmitted[] = [];
    const tools = createExecutor(
      [
        {
          point: 'tool.starting',
          id: 'guard',
          hook: () => ({ skipPermitting: true }),
        },
        {
          point: 'tool.permitting',
          hook: (event) => {
            permitting.push(event.toolCall.id);
          },
        },
      ],
      async ({ toolCall }) => {
        executed.push(toolCall.name);
        return { content: [] };
      },
    );
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({ requester: scripted, executor: tools });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(permitting).toEqual([]);
    expect(executed).toEqual(['alpha']);
    expect(events.find((event) => event.type === 'tool.ended')).toMatchObject({
      outcome: { type: 'succeeded' },
    });
    await loop.close();
  });

  it('settles a permitting rejection as a failed result in the history', async () => {
    const executed: string[] = [];
    const events: LoopEmitted[] = [];
    const tools = createExecutor(
      [
        {
          point: 'tool.permitting',
          id: 'permission',
          hook: () => ({
            blocked: { reason: 'denied' },
            result: { content: [{ type: 'text' as const, text: 'nope' }] },
          }),
        },
      ],
      async ({ toolCall }) => {
        executed.push(toolCall.name);
        return { content: [] };
      },
    );
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({ requester: scripted, executor: tools });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    expect(executed).toEqual([]);
    expect(events.find((event) => event.type === 'tool.ended')).toMatchObject({
      outcome: { type: 'failed' },
    });
    const entries = loop.state.messages.filter((entry): entry is ToolMessage => entry.role === 'tool');
    expect(entries).toHaveLength(1);
    expect(extractText(entries[0]!)).toBe('nope');
    expect(entries[0]?.attributes?.isError).toBe(true);
    await loop.close();
  });

  it('returns hook failures as failed results without native stopTurn', async () => {
    const events: LoopEmitted[] = [];
    const tools = createExecutor(
      [
        {
          point: 'tool.permitting',
          id: 'flaky-permission',
          hook: () => {
            throw new Error('oops');
          },
        },
      ],
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    );
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({ requester: scripted, executor: tools });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    const entry = loop.state.messages.find((item): item is ToolMessage => item.role === 'tool');
    expect(extractText(entry!)).toContain('permitting hook failed for "alpha": oops');
    expect(entry?.attributes?.stopTurn).toBeUndefined();
    await loop.close();

    const failedTools = createExecutor([], async () => {
      throw new Error('boom');
    });
    const failedScript = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const failedLoop = createLoop({ requester: failedScript, executor: failedTools });
    const failedEvents: LoopEmitted[] = [];
    failedLoop.subscribe((event) => failedEvents.push(event));
    expect((await failedLoop.runTurn(prompt('work'))).type).toBe('done');
    expect(failedEvents.find((event) => event.type === 'tool.ended')).toMatchObject({
      outcome: { type: 'failed', message: { attributes: { isError: true } } },
    });
    await failedLoop.close();
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
      requester: scripted,
      executor: successfulExecutor(['lookup', 'alpha', 'beta', 'work'], ''),
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
      requester: scripted,
      executor: successfulExecutor(['lookup', 'alpha', 'beta', 'work'], ''),
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
      requester: scripted,
      executor: executorFrom(['alpha', 'beta'], async ({ toolCall }: ToolExecuteInput) => {
        executed.push(toolCall.name);
        return { content: [] };
      }),
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
    expect(events.findIndex((event) => event.type === 'hook.failed')).toBeGreaterThan(
      events.findLastIndex((event) => event.type === 'tool.ended'),
    );
    const tools = loop.state.messages.filter((entry) => entry.role === 'tool');
    expect(tools.map((entry) => extractText(entry))).toEqual([
      '[hook failed] tool.batch-starting: bang',
      '[hook failed] tool.batch-starting: bang',
    ]);
    await loop.close();
  });
});

describe('notify turn handoff', () => {
  it('ends the current turn after a tool step and consumes notify in a new turn', async () => {
    const events: LoopEmitted[] = [];
    const scripted = requester([done('', [call('c1', 'alpha')]), done('notified'), done('after reset')]);
    const loop = createLoop({
      requester: scripted,
      executor: createExecutor([]),
      hooks: [
        {
          point: 'step.stopping',
          hook: (event) => {
            if (event.turnId === 0) loop.notify(prompt('new input'));
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    const followup = once(loop, (event) => event.type === 'turn.ended' && event.turnId === 1);
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    await followup;
    expect(events.filter((event) => event.type === 'step.started').map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(events.find((event) => event.type === 'turn.ended' && event.turnId === 0)).toMatchObject({
      outcome: { type: 'done', cause: { by: 'loop', reason: 'notify' } },
    });
    expect(events.find((event) => event.type === 'message.appended' && event.source === 'notify')).toMatchObject({
      turnId: 1,
      step: 0,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resetting = loop.reset(async () => {
      await gate;
      return { messages: loop.state.messages, nextTurnId: 0, historyRevision: 0 };
    });
    loop.notify(prompt('after reset'));
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(2);
    const afterReset = once(loop, (event) => event.type === 'turn.ended' && event.turnId === 2);
    release();
    await resetting;
    loop.start();
    await afterReset;
    expect(loop.hooks.list()).toHaveLength(1);
    expect(events.filter((event) => event.type === 'step.started').map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
    expect(events.filter((event) => event.type === 'turn.started').map((event) => event.message)).toEqual([
      prompt('work'),
      prompt('new input'),
      prompt('after reset'),
    ]);
    await loop.close();
  });

  it('hands each steered entry to its own turn without changing identity', async () => {
    const events: LoopEmitted[] = [];
    const starting: number[] = [];
    const scripted = requester([done('', [call('c1', 'alpha')]), done('second')]);
    const first = createUserMessage('first', { promptId: 'first' });
    const second = createUserMessage('second', { promptId: 'second' });
    const loop = createLoop({
      requester: scripted,
      executor: createExecutor([]),
      hooks: [
        {
          point: 'step.starting',
          hook: (event) => {
            starting.push(event.turnId);
          },
        },
        {
          point: 'step.stopping',
          hook: (event) => {
            if (event.turnId !== 0) return;
            loop.submit(first);
            loop.submit(second);
            loop.sendNow(['second', 'first']);
            loop.sendNow(['first']);
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    const followup = once(loop, (event) => event.type === 'turn.ended' && event.turnId === 2);
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    await followup;
    expect(starting).toEqual([0, 1, 2]);
    expect(events.find((event) => event.type === 'prompt.steered')).toMatchObject({
      promptIds: ['first', 'second'],
      messages: [first, second],
    });
    expect(events.filter((event) => event.type === 'message.appended' && event.source === 'notify')).toMatchObject([
      { turnId: 1, message: first },
      { turnId: 2, message: second },
    ]);
    expect(events.find((event) => event.type === 'turn.ended' && event.turnId === 1)).toMatchObject({
      outcome: { type: 'done', cause: { by: 'loop', reason: 'prompt_only' } },
    });
    expect(events.filter((event) => event.type === 'step.started').map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [2, 1],
    ]);
    await loop.close();
  });

  it('appends reminders immediately before the next request without splitting the turn', async () => {
    const events: LoopEmitted[] = [];
    const scripted = requester([done('', [call('c1', 'alpha')]), done('final')]);
    const loop = createLoop({
      requester: scripted,
      executor: createExecutor([]),
      hooks: [
        {
          point: 'step.stopping',
          hook: (event) => {
            if (event.turnId === 0 && event.step === 1) loop.remind(prompt('reminder'));
          },
        },
      ],
    });
    loop.subscribe((event) => events.push(event));
    expect((await loop.runTurn(prompt('work'))).type).toBe('done');
    const secondStep = events.findIndex((event) => event.type === 'step.started' && event.step === 2);
    const reminder = events.findIndex((event) => event.type === 'message.appended' && event.source === 'remind');
    expect(secondStep).toBeGreaterThanOrEqual(0);
    expect(reminder).toBeGreaterThan(secondStep);
    expect(events[reminder]).toMatchObject({ turnId: 0, step: 2, message: { role: 'user' } });
    expect(events.filter((event) => event.type === 'turn.ended').map((event) => event.turnId)).toEqual([0]);
    await loop.close();
  });

  it('does not run another step of an interrupted turn when notify is pending', async () => {
    const events: LoopEmitted[] = [];
    const scripted = requester([done('new turn')]);
    const loop = createLoop({
      requester: scripted,
      executor: createExecutor([]),
      input: {
        messages: [prompt('old')],
        inbox: { notify: [prompt('wake')] },
        nextTurnId: 1,
        unfinished: { turnId: 0, trigger: 'normal', step: 1, stepUnfinished: true, appended: true },
      },
    });
    loop.subscribe((event) => events.push(event));
    const followup = once(loop, (event) => event.type === 'turn.ended' && event.turnId === 1);
    loop.continue();
    await followup;
    expect(events.find((event) => event.type === 'turn.resumed')).toMatchObject({ turnId: 0, step: 1 });
    expect(events.find((event) => event.type === 'turn.ended' && event.turnId === 0)).toMatchObject({
      outcome: { type: 'done', cause: { by: 'loop', reason: 'notify' } },
    });
    expect(events.filter((event) => event.type === 'step.started').map((event) => [event.turnId, event.step])).toEqual([
      [1, 1],
    ]);
    await loop.close();
  });
});
