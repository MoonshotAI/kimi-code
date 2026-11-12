import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IFileService } from '#/app/file/fileService';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService, type PromptHandle } from '#/agent/loop/loop';
import { TurnStarted, TurnStepInterrupted } from '#/agent/loop/turnEvents';
import { TurnPrompt } from '#/agent/loop/turnOps';
import { emptyUsage } from '@moonshot-ai/core/llm/usage';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import {
  PromptAborted,
  PromptCompleted,
  PromptQueued,
  PromptStarted,
  PromptSteered,
  PromptSubmitted,
} from '#/agent/prompt/promptEvents';
import type { ContentPart, Message } from '@moonshot-ai/core/llm/message';

import {
  appService,
  createTestAgent,
  createMockProvider,
  sessionService,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

function message(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], origin: { kind: 'user' } };
}

function bundledMessage(skillName: string, user: string, extra: readonly ContentPart[] = [], marked = false): ContextMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<skill>${skillName}</skill>`,
        meta: marked ? { source: 'skill activation', activationId: `act-${skillName}` } : undefined,
      },
      { type: 'text', text: user },
      ...extra,
    ],
    origin: { kind: 'user', skillActivations: [{ activationId: `act-${skillName}`, skillName }] },
  };
}

function daemonIntake() {
  return {
    get: vi.fn(async () => ({
      meta: {
        id: 'file_1',
        size: 3,
        name: 'pic.png',
        media_type: 'image/png',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      stream: () => Readable.from([new Uint8Array([1, 2, 3])]),
    })),
    materialize: vi.fn(async (): Promise<string | undefined> => undefined),
  };
}

async function enqueue(
  loop: IAgentLoopService,
  input: { id?: string; message: ContextMessage },
): Promise<PromptHandle> {
  const status = loop.snapshot();
  const { id } = loop.submit({
    role: 'user',
    content: [...input.message.content],
    attributes: { promptId: input.id, origin: input.message.origin },
  });
  const handle = loop.promptHandle(id)!;
  if (status.state === 'idle' && !status.paused && status.queue.length === 0) {
    await Promise.race([handle.launched, handle.completion]);
  }
  return handle;
}

function pendingIds(loop: IAgentLoopService): readonly (string | undefined)[] {
  return loop.snapshot().queue.map((item) => item.attributes?.promptId);
}

describe('prompt queue', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;

  afterEach(async () => {
    await ctx.dispose();
  });

  function setup(...inputs: (TestAgentOptions | TestAgentServiceOverride)[]): void {
    ctx = createTestAgent(...inputs);
    loop = ctx.get(IAgentLoopService);
  }

  function holdNextStep(): { readonly started: Promise<void>; readonly release: () => void } {
    let releaseGate!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let armed = true;
    loop.hooks.onWillBeginStep.register('test-hold-step', async (_hookCtx, next) => {
      if (armed) {
        armed = false;
        markStarted();
        await gate;
      }
      await next();
    });
    return {
      started,
      release: () => {
        releaseGate();
      },
    };
  }

  it('assigns stable identity and launches an idle prompt', async () => {
    setup();
    ctx.mockNextResponse({ type: 'text', text: 'hi' });

    const handle = await enqueue(loop, { id: 'prompt-1', message: message('hello') });
    expect(handle.id).toBe('prompt-1');
    expect(handle.userMessageId).toBe('prompt-1');
    expect((await handle.launched)?.id).toBe(0);
    await loop.settled();
  });

  it('keeps later prompts in FIFO order while active', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'two' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const first = await enqueue(loop, { message: message('one') });
    const second = await enqueue(loop, { message: message('two') });
    expect(pendingIds(loop)).toEqual([first.id, second.id]);

    hold.release();
    await loop.settled();
  });

  it('publishes prompt.queued only for prompts that cannot launch immediately', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'waiting' });
    const queued: Array<{ promptId: string; queueLength: number }> = [];
    ctx.get(IEventBus).subscribe(PromptQueued, (event) => {
      queued.push({ promptId: event.promptId, queueLength: event.queueLength });
    });

    await enqueue(loop, { id: 'active', message: message('active') });
    await hold.started;
    expect(queued).toEqual([]);

    await enqueue(loop, { id: 'waiting', message: message('waiting') });
    expect(queued).toEqual([{ promptId: 'waiting', queueLength: 1 }]);

    hold.release();
    await loop.settled();
  });

  it('publishes prompt.submitted for every user prompt and prompt.started on launch', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'waiting' });
    const submitted: Array<{ promptId: string; userMessageId: string; status: string; content: readonly ContentPart[] }> = [];
    const started: string[] = [];
    ctx.get(IEventBus).subscribe(PromptSubmitted, (event) => {
      submitted.push({
        promptId: event.promptId,
        userMessageId: event.userMessageId,
        status: event.status,
        content: event.content,
      });
    });
    ctx.get(IEventBus).subscribe(PromptStarted, (event) => {
      started.push(event.promptId);
    });

    const active = await enqueue(loop, { id: 'active', message: message('active') });
    expect(submitted).toEqual([
      { promptId: 'active', userMessageId: 'active', status: 'running', content: [{ type: 'text', text: 'active' }] },
    ]);
    await active.launched;
    expect(started).toEqual(['active']);

    await enqueue(loop, { id: 'waiting', message: message('waiting') });
    expect(submitted).toEqual([
      { promptId: 'active', userMessageId: 'active', status: 'running', content: [{ type: 'text', text: 'active' }] },
      { promptId: 'waiting', userMessageId: 'waiting', status: 'queued', content: [{ type: 'text', text: 'waiting' }] },
    ]);
    expect(started).toEqual(['active']);

    hold.release();
    await loop.settled();
  });

  it('atomically rejects steer when any id is not pending', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'one' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const queued = await enqueue(loop, { message: message('one') });
    await expect(loop.steer([queued.id, 'missing'])).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(pendingIds(loop)).toEqual([queued.id]);

    hold.release();
    await loop.settled();
  });

  it('steers selected prompts in FIFO order', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    const steered: PromptSteered[] = [];
    ctx.get(IEventBus).subscribe(PromptSteered, (event) => steered.push(event));

    const active = await enqueue(loop, { message: message('active') });
    await hold.started;
    const one = await enqueue(loop, { message: message('one') });
    const two = await enqueue(loop, { message: message('two') });
    await loop.steer([two.id, one.id]);
    expect(steered.map((event) => [event.activePromptId, event.promptIds])).toEqual([
      [active.id, [one.id]],
      [active.id, [two.id]],
    ]);

    hold.release();
    await loop.settled();
  });

  it('publishes turn.prompt for each message in its own turn', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    const steered: PromptSteered[] = [];
    const events: TurnPrompt[] = [];
    ctx.get(IEventBus).subscribe(PromptSteered, (event) => steered.push(event));
    ctx.get(IEventBus).subscribe(TurnPrompt, (event) => events.push(event));

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const one = await enqueue(loop, { message: message('one') });
    const two = await enqueue(loop, { message: message('two') });

    await loop.steer([two.id, one.id]);
    expect(events.filter((event) => event.trigger === 'notify')).toHaveLength(0);
    expect(steered.map((event) => [event.messageId, event.promptIds])).toEqual([
      [one.id, [one.id]],
      [two.id, [two.id]],
    ]);

    hold.release();
    await loop.settled();
    const materialized = events.filter((event) => event.trigger === 'notify');
    expect(materialized.map((event) => event.turnId)).toEqual([1, 2]);
    expect(materialized[0]?.input).toEqual([{ type: 'text', text: 'one' }]);
    expect(materialized[0]?.promptId).toBe(one.id);
    expect(materialized[1]?.input).toEqual([{ type: 'text', text: 'two' }]);
    expect(materialized[1]?.promptId).toBe(two.id);
  });

  it('keeps each steered prompt client metadata in FIFO order without adding it to model content', async () => {
    setup();
    const hold = holdNextStep();
    const eventBus = ctx.get(IEventBus);
    const events: TurnPrompt[] = [];
    const submitted: PromptSubmitted[] = [];
    const queued: PromptQueued[] = [];
    const steered: PromptSteered[] = [];
    eventBus.subscribe(PromptSubmitted, (event) => submitted.push(event));
    eventBus.subscribe(PromptQueued, (event) => queued.push(event));
    eventBus.subscribe(PromptSteered, (event) => steered.push(event));
    eventBus.subscribe(TurnPrompt, (event) => events.push(event));
    await enqueue(loop, { message: message('active') });
    await hold.started;
    const first = { composer: { version: 1, refId: 'first' } };
    const second = { composer: { version: 1, refId: 'second' } };
    const one = await enqueue(loop, { message: { ...message('one'), origin: { kind: 'user', clientMetadata: [first] } } });
    const two = await enqueue(loop, { message: { ...message('two'), origin: { kind: 'user', clientMetadata: [second] } } });
    await loop.steer([two.id, one.id]);
    await Promise.resolve();
    expect(events.filter((event) => event.trigger === 'notify')).toHaveLength(0);
    expect(submitted.find((event) => event.promptId === one.id)?.clientMetadata).toEqual([first]);
    expect(queued.find((event) => event.promptId === two.id)?.clientMetadata).toEqual([second]);
    expect(PromptSteered.schema.parse(steered[0]).promptIds).toEqual([one.id]);
    hold.release();
    await loop.settled();
    const materialized = events.filter((event) => event.trigger === 'notify');
    expect(materialized.map((event) => event.turnId)).toEqual([1, 2]);
    const messages = ctx
      .get(IAgentLoopService)
      .history()
      .filter(
        (entry) =>
          entry.role === 'user' &&
          entry.content.some((part) => part.type === 'text' && (part.text === 'one' || part.text === 'two')),
      );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: one.id,
      origin: { kind: 'user', clientMetadata: [first] },
      content: [{ type: 'text', text: 'one' }],
    });
    expect(messages[1]).toMatchObject({
      id: two.id,
      origin: { kind: 'user', clientMetadata: [second] },
      content: [{ type: 'text', text: 'two' }],
    });
    expect(messages.map((message) => message.id)).toEqual(steered.map((event) => event.messageId));
  });

  it('keeps plain inputs beside composer metadata in a mixed steer', async () => {
    setup();
    const hold = holdNextStep();
    const eventBus = ctx.get(IEventBus);
    const events: TurnPrompt[] = [];
    eventBus.subscribe(TurnPrompt, (event) => events.push(event));
    await enqueue(loop, { message: message('active') });
    await hold.started;
    const metadata = { display_text: 'Save button', kimi_code_composer: { version: 1 } };
    const one = await enqueue(loop, { message: message('[literal](example.md)') });
    const two = await enqueue(loop, { message: { ...message('browser wire'), origin: { kind: 'user', clientMetadata: [metadata] } } });
    const three = await enqueue(loop, { message: message('last instruction') });
    await loop.steer([three.id, two.id, one.id]);
    await Promise.resolve();
    expect(events.filter((event) => event.trigger === 'notify')).toHaveLength(0);
    hold.release();
    await loop.settled();
    const materialized = events.filter((event) => event.trigger === 'notify');
    expect(materialized.map((event) => event.turnId)).toEqual([1, 2, 3]);
    const messages = ctx
      .get(IAgentLoopService)
      .history()
      .filter(
        (entry) =>
          entry.role === 'user' &&
          entry.content.some((part) =>
            part.type === 'text' && ['[literal](example.md)', 'browser wire', 'last instruction'].includes(part.text),
          ),
      );
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ id: one.id, content: [{ type: 'text', text: '[literal](example.md)' }] });
    expect(messages[1]).toMatchObject({
      id: two.id,
      origin: { clientMetadata: [metadata] },
      content: [{ type: 'text', text: 'browser wire' }],
    });
    expect(messages[2]).toMatchObject({ id: three.id, content: [{ type: 'text', text: 'last instruction' }] });
  });

  it('publishes prompt identities before each steered user message', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    const events: (PromptSteered | TurnPrompt)[] = [];
    ctx.get(IEventBus).subscribe(PromptSteered, (event) => events.push(event));
    ctx.get(IEventBus).subscribe(TurnPrompt, (event) => events.push(event));

    const active = await enqueue(loop, { message: message('active') });
    await hold.started;
    const one = await enqueue(loop, { message: message('same text') });
    const two = await enqueue(loop, { message: message('same text') });
    await loop.steer([two.id, one.id]);
    const three = await enqueue(loop, { message: message('same text') });
    await loop.steer([three.id]);
    const reserved = events.filter((event): event is PromptSteered => 'activePromptId' in event);
    expect(reserved).toMatchObject([
      { type: 'prompt.steered', activePromptId: active.id, promptIds: [one.id] },
      { type: 'prompt.steered', activePromptId: active.id, promptIds: [two.id] },
      { type: 'prompt.steered', activePromptId: active.id, promptIds: [three.id] },
    ]);
    expect(events.filter((event): event is TurnPrompt => 'trigger' in event && event.trigger === 'notify')).toHaveLength(0);

    hold.release();
    await loop.settled();

    const materialized = events.filter((event): event is TurnPrompt => 'trigger' in event && event.trigger === 'notify');
    expect(materialized).toMatchObject([
      { type: 'turn.prompt', turnId: 1, input: [{ type: 'text', text: 'same text' }] },
      { type: 'turn.prompt', turnId: 2, input: [{ type: 'text', text: 'same text' }] },
      { type: 'turn.prompt', turnId: 3, input: [{ type: 'text', text: 'same text' }] },
    ]);
    expect(materialized.map((event) => event.promptId)).toEqual(reserved.map((event) => event.messageId));
    expect(materialized.map((event) => event.promptId)).toEqual([one.id, two.id, three.id]);
  });

  it('returns the prompt identity and delivery state for an accepted steer', async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    let requests = 0;
    const histories: (readonly Message[])[] = [];
    const generate = createMockProvider(async (request, signal) => {
      const history = [...request.content.messages];
      const options = {
        signal,
        cacheKey: request.model.cacheKey,
        sampling: request.model.sampling,
        thinking: request.model.thinking,
        maxOutputTokens: request.model.maxOutputTokens,
        maxContextSize: request.model.spec.maxContextSize,
        usedTokens: request.content.usedTokens,
      };
      histories.push(structuredClone(history));
      requests += 1;
      if (requests === 1) {
        return {
          id: 'mock-1',
          parts: [{ type: 'text', text: 'partial answer' }],
          error: new Promise<unknown>((resolve) => {
            if (options.signal.aborted) {
              resolve(options.signal.reason);
              return;
            }
            options.signal.addEventListener('abort', () => resolve(options.signal.reason), { once: true });
          }),
          onStream: requestStarted,
        };
      }
      return {
        id: 'mock-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'after steer' }], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    });
    setup({ generate });
    const interrupted: TurnStepInterrupted[] = [];
    ctx.get(IEventBus).subscribe(TurnStepInterrupted, (event) => interrupted.push(event));
    const active = await enqueue(loop, { message: message('active') });
    await started;

    const result = await ctx.rpc.steer({ input: [{ type: 'text', text: 'steer' }] });
    await loop.settled();

    expect(result).toMatchObject({
      prompt_id: expect.any(String),
      state: 'running',
      steered: true,
      turn_id: 1,
    });
    await expect(active.completion).resolves.toMatchObject({ state: 'completed' });
    expect(interrupted).toMatchObject([{ turnId: 0, step: 1, stepId: expect.any(String), reason: 'steered' }]);
    expect(loop.history()).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
    }));
    expect(histories[1]?.slice(-3)).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'active' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'steer' }] },
    ]);
  });

  it('accepts new and queued steers during any active turn without overtaking normal FIFO', async () => {
    setup();
    await ctx.restorePersisted();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'continuation' });
    const prompts: TurnPrompt[] = [];
    const interrupted: TurnStepInterrupted[] = [];
    ctx.get(IEventBus).subscribe(TurnPrompt, (event) => prompts.push(event));
    ctx.get(IEventBus).subscribe(TurnStepInterrupted, (event) => interrupted.push(event));
    loop.submit({
      role: 'user',
      content: message('continuation').content,
      attributes: { promptId: 'continuation', origin: { kind: 'system_trigger', name: 'goal_continuation' } as PromptOrigin },
    });
    await hold.started;
    expect(loop.snapshot()).toMatchObject({ activeTurnId: 0, activePromptId: 'continuation' });

    const steered = await enqueue(loop, { id: 'steered', message: message('steered') });
    const normal = await enqueue(loop, { id: 'normal', message: message('normal') });
    await loop.sendNow([steered.id]);
    await loop.sendNow([steered.id]);
    const pending = ctx.rpc.steer({ input: [{ type: 'text', text: 'direct steer' }] });
    hold.release();
    const result = await pending;
    await loop.settled();

    expect(result).toMatchObject({
      prompt_id: expect.any(String),
      state: 'running',
      steered: true,
      turn_id: 3,
    });
    expect(prompts.slice(1).map((event) => [event.turnId, event.trigger, event.promptId])).toEqual([
      [1, 'normal', normal.id],
      [2, 'notify', steered.id],
      [3, 'notify', result.prompt_id],
    ]);
    expect(ctx.allEvents).toContainEqual(expect.objectContaining({
      event: 'turn.ended',
      args: expect.objectContaining({ turnId: 0, reason: 'completed' }),
    }));
    expect(interrupted).toMatchObject([{ turnId: 0, step: 1, stepId: expect.any(String), reason: 'steered' }]);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.llmCalls[0]?.history.filter((entry) => entry.role === 'user')).toMatchObject([
      { content: [{ type: 'text', text: 'continuation' }] },
      { content: [{ type: 'text', text: 'normal' }] },
      { content: [{ type: 'text', text: 'steered' }] },
      { content: [{ type: 'text', text: 'direct steer' }] },
    ]);
    expect(ctx.llmCalls[0]?.history.some((entry) => entry.role === 'assistant')).toBe(false);
  });

  it('publishes turn.prompt when an unconsumed steer seeds the next turn after cancel', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'seeded turn' });
    const steerEvents: TurnPrompt[] = [];
    ctx.get(IEventBus).subscribe(TurnPrompt, (event) => {
      if (event.trigger === 'notify') steerEvents.push(event);
    });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const stop = await enqueue(loop, { message: message('stop') });
    await loop.steer([stop.id]);
    loop.cancel();
    hold.release();
    await loop.settled();

    expect(steerEvents).toHaveLength(1);
    expect(steerEvents[0]).toMatchObject({ turnId: 1, promptId: stop.id });
    const materializedStops = ctx
      .get(IAgentLoopService)
      .history()
      .filter(
        (entry) =>
          entry.role === 'user' &&
          entry.content.some((part) => part.type === 'text' && part.text === 'stop'),
      );
    expect(materializedStops).toHaveLength(1);
  });

  it('preserves a notified steer when cancellation wins before the next gate', async () => {
    setup();
    let releaseFinish!: () => void;
    let markFinishing!: () => void;
    const finishing = new Promise<void>((resolve) => { markFinishing = resolve; });
    const finishGate = new Promise<void>((resolve) => { releaseFinish = resolve; });
    let armed = true;
    loop.hooks.onDidFinishStep.register('test-hold-finish-step', async (_hookCtx, next) => {
      if (armed) {
        armed = false;
        markFinishing();
        await finishGate;
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    const steerEvents: TurnPrompt[] = [];
    ctx.get(IEventBus).subscribe(TurnPrompt, (event) => {
      if (event.trigger === 'notify') steerEvents.push(event);
    });

    await enqueue(loop, { message: message('active') });
    await finishing;
    const { id } = loop.notify({
      role: 'user',
      content: message('stop').content,
      attributes: { origin: { kind: 'user' } },
    });
    loop.cancel();
    releaseFinish();
    await loop.settled();

    expect(steerEvents).toHaveLength(1);
    expect(steerEvents[0]).toMatchObject({ turnId: 1, promptId: id });
    const materializedStops = loop
      .history()
      .filter(
        (entry) =>
          entry.role === 'user' &&
          entry.content.some((part) => part.type === 'text' && part.text === 'stop'),
      );
    expect(materializedStops).toHaveLength(1);
  });

  it('aborts pending prompts and settles completion', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    const aborted: PromptAborted[] = [];
    ctx.get(IEventBus).subscribe(PromptAborted, (event) => aborted.push(event));

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const handle = await enqueue(loop, { message: message('queued') });
    expect(loop.cancel({ promptId: handle.id })).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(pendingIds(loop)).toEqual([]);
    expect(aborted.map((event) => event.promptId)).toEqual([handle.id]);

    hold.release();
    await loop.settled();
  });

  it('keeps injections outside the prompt queue', async () => {
    setup();
    ctx.mockNextResponse({ type: 'text', text: 'injected' });

    const { id } = loop.submit({
      role: 'user',
      content: message('system').content,
      attributes: { origin: { kind: 'injection', variant: 'test' } as PromptOrigin },
    });
    const turn = await loop.promptHandle(id)!.launched;
    expect(loop.snapshot().queue).toEqual([]);
    expect(loop.snapshot().activePromptId).toBe(id);
    await turn?.result;
    await loop.settled();
  });

  it('settles blocked prompts', async () => {
    setup();
    const completed: PromptCompleted[] = [];
    ctx.get(IEventBus).subscribe(PromptCompleted, (event) => completed.push(event));
    loop.hooks.onBeforeSubmitPrompt.register('block', async (hookCtx, next) => {
      hookCtx.block = true;
      await next();
    });

    const handle = await enqueue(loop, { message: message('blocked') });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });
    expect(completed.map((event) => [event.promptId, event.reason])).toEqual([[handle.id, 'blocked']]);
  });

  it('returns the prompt identity when a steer is blocked by the prompt hook', async () => {
    setup();
    loop.hooks.onBeforeSubmitPrompt.register('block', async (hookCtx, next) => {
      hookCtx.block = true;
      await next();
    });

    const result = await ctx.rpc.steer({ input: [{ type: 'text', text: 'blocked steer' }] });

    expect(result).toMatchObject({
      prompt_id: expect.any(String),
      state: 'blocked',
      steered: false,
    });
    expect(result).not.toHaveProperty('turn_id');
  });

  it('exposes the in-flight gate item in the queue snapshot', async () => {
    setup();
    ctx.mockNextResponse({ type: 'text', text: 'launched' });
    let releaseHook!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const started: string[] = [];
    ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      if (event.prompt !== undefined) started.push(event.prompt);
    });
    loop.hooks.onBeforeSubmitPrompt.register('gate', async (hookCtx, next) => {
      markEntered();
      hookCtx.hookParts.push({
        type: 'text',
        text: '<hook_result hook_event="UserPromptSubmit">\nfrom hook\n</hook_result>',
        meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
      });
      await new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      await next();
    });

    const bundled = bundledMessage('review', 'launching');
    const { id } = loop.submit({
      role: 'user',
      content: bundled.content,
      attributes: { origin: bundled.origin as PromptOrigin },
    });
    await entered;
    expect(pendingIds(loop)).toEqual([id]);
    expect(loop.snapshot().activePromptId).toBeUndefined();
    releaseHook();
    await loop.promptHandle(id)!.launched;
    expect(loop.snapshot().queue).toHaveLength(0);
    await loop.settled();

    const history = ctx.context.history();
    expect(history[0]?.role).toBe('user');
    expect(history[0]?.content).toEqual([
      {
        type: 'text',
        text: '<hook_result hook_event="UserPromptSubmit">\nfrom hook\n</hook_result>',
        meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
      },
      { type: 'text', text: '<skill>review</skill>', meta: { activationId: 'act-review', source: 'skill activation' } },
      { type: 'text', text: 'launching' },
    ]);
    expect(started).toEqual(['launching']);
    const turnPrompt = (await ctx.persistedWireRecords()).find(
      (record) => record.type === 'turn.prompt',
    );
    expect((turnPrompt as { input?: unknown } | undefined)?.input).toEqual([
      {
        type: 'text',
        text: '<hook_result hook_event="UserPromptSubmit">\nfrom hook\n</hook_result>',
        meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
      },
      { type: 'text', text: '<skill>review</skill>', meta: { activationId: 'act-review', source: 'skill activation' } },
      { type: 'text', text: 'launching' },
    ]);
  });

  it('delivers a blocked prompt’s compression captions inline in their host message', async () => {
    setup();
    loop.hooks.onBeforeSubmitPrompt.register('block', async (hookCtx, next) => {
      hookCtx.block = true;
      await next();
    });

    const handle = await enqueue(loop, {
      id: 'prompt-caption',
      message: message('<system>Image compressed to fit model limits: 800x600</system>look at this'),
    });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });

    const history = ctx.context.history();
    expect(history).toHaveLength(1);
    expect(history[0]?.origin).toEqual({ kind: 'user' });
    expect(history[0]?.content).toEqual([
      {
        type: 'text',
        text: '<system>Image compressed to fit model limits: 800x600</system>look at this',
      },
    ]);
  });

  it('settles the prompt as failed when the launch pipeline throws', async () => {
    setup();
    loop.hooks.onBeforeSubmitPrompt.register('explode', () => {
      throw new Error('boom');
    });

    const handle = await enqueue(loop, { id: 'prompt-x', message: message('hello') });
    expect(handle.state).toBe('failed');
    await expect(handle.launched).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({ state: 'failed', result: undefined });
    expect(loop.snapshot().queue).toEqual([]);
    expect(loop.snapshot().activePromptId).toBeUndefined();
  });

  it('replaces an unsupported prompt image with a text notice at the history funnel', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'seen' });
    vi.spyOn(ctx.get(IAgentLoopService), 'getModelProviderType').mockReturnValue(undefined);
    const url = `data:image/avif;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;

    await enqueue(loop, {
      id: 'prompt-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url } }],
        origin: { kind: 'user' },
      },
    });
    await hold.started;

    const appended = ctx.context.history();
    expect(appended).toHaveLength(1);
    const parts = appended[0]!.content;
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('image/avif');

    hold.release();
    await loop.settled();
  });

  it('keeps a prompt image whose format the bound provider accepts', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'seen' });
    const url = `data:image/heic;base64,${Buffer.from([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]).toString('base64')}`;

    await enqueue(loop, {
      id: 'prompt-heic',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url } }],
        origin: { kind: 'user' },
      },
    });
    await hold.started;

    const parts = ctx.context.history()[0]!.content;
    expect(parts).toEqual([{ type: 'image_url', imageUrl: { url } }]);

    hold.release();
    await loop.settled();
  });

  it('gates steered prompt images too', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    vi.spyOn(ctx.get(IAgentLoopService), 'getModelProviderType').mockReturnValue(undefined);

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const url = `data:image/avif;base64,${Buffer.from([4, 5, 6]).toString('base64')}`;
    const queued = await enqueue(loop, {
      id: 'prompt-steer-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url } }],
        origin: { kind: 'user' },
      },
    });
    await loop.steer([queued.id]);

    hold.release();
    await loop.settled();

    const parts = ctx.context.history().flatMap((entry) => entry.content);
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(
      parts.some((part) => part.type === 'text' && part.text.includes('image/avif')),
    ).toBe(true);
  });

  it('materializes daemon-ref media at steer intake', async () => {
    const intake = daemonIntake();
    setup(
      appService(IFileService, {
        _serviceBrand: undefined,
        get: intake.get,
      } as unknown as IFileService),
      sessionService(ISessionMediaStore, {
        _serviceBrand: undefined,
        materialize: intake.materialize,
      } as unknown as ISessionMediaStore),
    );
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const queued = await enqueue(loop, {
      id: 'prompt-steer-daemon',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: 'kimi-file://file_1' } }],
        origin: { kind: 'user' },
      },
    });

    await loop.steer([queued.id]);

    expect(intake.get).toHaveBeenCalledWith('file_1');
    expect(intake.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file_1', name: 'pic.png' }),
    );

    hold.release();
    await loop.settled();
  });

  it('publishes each record’s user parts when steering bundled prompts', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    const steered: ContentPart[][] = [];
    ctx.get(IEventBus).subscribe(PromptSteered, (event) => steered.push(event.content));

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const one = await enqueue(loop, { message: bundledMessage('review', 'first user text') });
    const two = await enqueue(loop, { message: bundledMessage('security', 'second user text') });

    await loop.steer([one.id, two.id]);

    expect(steered).toHaveLength(2);
    expect(steered[0]).toEqual([{ type: 'text', text: 'first user text' }]);
    expect(steered[1]).toEqual([{ type: 'text', text: 'second user text' }]);

    hold.release();
    await loop.settled();
  });

  it('publishes only caller parts when a bundled prompt queues', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'bundled' });
    const queued: Array<{ promptId: string; content: ContentPart[] }> = [];
    ctx.get(IEventBus).subscribe(PromptQueued, (event) => {
      queued.push({ promptId: event.promptId, content: event.content });
    });

    await enqueue(loop, { message: message('active') });
    await hold.started;

    await enqueue(loop, { id: 'bundled', message: bundledMessage('review', 'user text') });
    await enqueue(loop, { id: 'marked-bundled', message: bundledMessage('security', 'marked text', [], true) });

    expect(queued).toEqual([
      { promptId: 'bundled', content: [{ type: 'text', text: 'user text' }] },
      { promptId: 'marked-bundled', content: [{ type: 'text', text: 'marked text' }] },
    ]);

    hold.release();
    await loop.settled();
  });

  it('rejects the whole steer when a selected prompt is aborted during intake', async () => {
    const intake = daemonIntake();
    setup(
      appService(IFileService, {
        _serviceBrand: undefined,
        get: intake.get,
      } as unknown as IFileService),
      sessionService(ISessionMediaStore, {
        _serviceBrand: undefined,
        materialize: intake.materialize,
      } as unknown as ISessionMediaStore),
    );
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'b' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    let releaseIntake!: () => void;
    intake.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseIntake = () => {
            resolve({
              meta: {
                id: 'file_1',
                size: 3,
                name: 'pic.png',
                media_type: 'image/png',
                created_at: '2026-01-01T00:00:00.000Z',
              },
              stream: () => Readable.from([new Uint8Array([1, 2, 3])]),
            });
          };
        }),
    );
    await enqueue(loop, {
      id: 'a',
      message: bundledMessage('review', 'a text', [
        { type: 'image_url', imageUrl: { url: 'kimi-file://file_1' } },
      ]),
    });
    await enqueue(loop, { id: 'b', message: message('b') });

    const steerPromise = loop.steer(['a', 'b']);
    loop.cancel({ promptId: 'a' });
    releaseIntake();

    await expect(steerPromise).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(pendingIds(loop)).toEqual(['b']);

    hold.release();
    await loop.settled();
  });

  it('keeps bundled skill blocks with each steered message', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const one = await enqueue(loop, { message: bundledMessage('review', 'user A') });
    const two = await enqueue(loop, { message: bundledMessage('security', 'user B') });

    await loop.steer([one.id, two.id]);
    hold.release();
    await loop.settled();

    const messages = ctx.context.history().filter(
      (entry) => entry.origin?.kind === 'user' && entry.origin.skillActivations !== undefined,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toEqual([
      {
        type: 'text',
        text: '<skill>review</skill>',
        meta: { source: 'skill activation', activationId: 'act-review' },
      },
      { type: 'text', text: 'user A' },
    ]);
    expect(messages[1]?.content).toEqual([
      {
        type: 'text',
        text: '<skill>security</skill>',
        meta: { source: 'skill activation', activationId: 'act-security' },
      },
      { type: 'text', text: 'user B' },
    ]);
  });

  it('preserves each prompt origin file attachments when steering queued prompts', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const one = await enqueue(loop, {
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'one' }],
        origin: {
          kind: 'user',
          attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 1, path: '/data/a.txt' }],
        },
      },
    });
    const two = await enqueue(loop, {
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'two' }],
        origin: {
          kind: 'user',
          attachments: [{ name: 'b.txt', mediaType: 'text/plain', size: 2, path: '/data/b.txt' }],
        },
      },
    });

    await loop.steer([one.id, two.id]);
    hold.release();
    await loop.settled();

    const messages = ctx.context.history().filter(
      (entry) => entry.origin?.kind === 'user' && entry.origin.attachments !== undefined,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.origin?.kind === 'user' && messages[0].origin.attachments).toEqual([
      { name: 'a.txt', mediaType: 'text/plain', size: 1, path: '/data/a.txt' },
    ]);
    expect(messages[1]?.origin?.kind === 'user' && messages[1].origin.attachments).toEqual([
      { name: 'b.txt', mediaType: 'text/plain', size: 2, path: '/data/b.txt' },
    ]);
    expect(messages[0]?.origin?.kind === 'user' && messages[0].origin.skillActivations).toBeUndefined();
    expect(messages[1]?.origin?.kind === 'user' && messages[1].origin.skillActivations).toBeUndefined();
  });

  it('launches and settles a fresh steered submission in the next turn', async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    let requests = 0;
    let aborted = false;
    const generate = createMockProvider(async (request, signal) => {
      const options = {
        signal,
        cacheKey: request.model.cacheKey,
        sampling: request.model.sampling,
        thinking: request.model.thinking,
        maxOutputTokens: request.model.maxOutputTokens,
        maxContextSize: request.model.spec.maxContextSize,
        usedTokens: request.content.usedTokens,
      };
      requests += 1;
      if (requests === 1) {
        const toolCall = { type: 'function' as const, id: 'call-work', name: 'Work', arguments: '{}' };
        options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return {
          id: 'mock-tool-call',
          message: { role: 'assistant', content: [], toolCalls: [toolCall] },
          parts: [toolCall],
          usage: emptyUsage(),
          finishReason: 'tool_calls',
          rawFinishReason: 'tool_calls',
          onStream: async () => {
            requestStarted();
            await requestGate;
          },
        };
      }
      
      return {
        id: 'mock-after-steer',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'after steer' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    });
    setup({ generate });
    const steered: PromptSteered[] = [];
    ctx.get(IEventBus).subscribe(PromptSteered, (event) => steered.push(event));

    const active = await enqueue(loop, { message: message('active') });
    await started;
    const { id } = loop.sendNow({
      role: 'user',
      content: message('steer me').content,
      attributes: {},
    });
    const handle = loop.promptHandle(id)!;

    expect(steered.map((event) => [event.activePromptId, event.promptIds])).toEqual([
      [active.id, [id]],
    ]);
    expect(handle.state).toBe('steered');
    let launched = false;
    void handle.launched.then(() => {
      launched = true;
    });
    await Promise.resolve();
    expect(launched).toBe(false);
    expect(aborted).toBe(false);

    releaseRequest();
    await expect(handle.launched).resolves.toMatchObject({ id: 1, state: 'running' });
    await expect(handle.completion).resolves.toMatchObject({ state: 'completed' });
    await loop.settled();
    expect(aborted).toBe(false);
  });

  it('carries submit metadata on the queue snapshot', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const { id } = loop.submit({
      role: 'user',
      content: message('meta').content,
      attributes: { promptId: 'meta-id' },
    });

    expect(loop.snapshot().queue).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          promptId: 'meta-id',
          origin: { kind: 'user' },
          userMessageId: 'meta-id',
        }),
      }),
    ]);
    expect(loop.snapshot().queue[0]?.attributes?.createdAt).not.toBe('');

    hold.release();
    await loop.settled();
  });

  it('leaves the queue untouched after a rejected steer and lets it proceed afterwards', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'a' });
    ctx.mockNextResponse({ type: 'text', text: 'b' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const a = await enqueue(loop, { id: 'a', message: message('a') });
    await enqueue(loop, { id: 'b', message: message('b') });

    await expect(loop.steer(['a', 'missing'])).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(pendingIds(loop)).toEqual(['a', 'b']);

    hold.release();
    await expect(a.launched).resolves.toBeDefined();
    expect((await a.launched)?.id).toBe(1);
    expect(loop.snapshot().activePromptId).toBe('a');
    expect(pendingIds(loop)).toEqual(['b']);
    await loop.settled();
  });
});
