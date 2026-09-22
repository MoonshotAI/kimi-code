import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IFileService } from '#/app/file/fileService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService, type PromptHandle } from '#/agent/loop/loop';
import { TurnSteer } from '#/agent/loop/turnOps';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  PromptAborted,
  PromptCompleted,
  PromptQueued,
  PromptStarted,
  PromptSteered,
  PromptSubmitted,
} from '#/agent/prompt/promptEvents';
import type { ContentPart } from '#human/llm/message';

import {
  appService,
  createTestAgent,
  sessionService,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

function message(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function bundledMessage(skillName: string, user: string, extra: readonly ContentPart[] = []): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<skill>${skillName}</skill>` }, { type: 'text', text: user }, ...extra],
    toolCalls: [],
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
    message: { role: 'user', content: [...input.message.content] },
    meta: { promptId: input.id, origin: input.message.origin, tracked: true },
  });
  const handle = loop.promptHandle(id)!;
  if (status.state === 'idle' && !status.paused && status.queue.length === 0) {
    await Promise.race([handle.launched, handle.completion]);
  }
  return handle;
}

function pendingIds(loop: IAgentLoopService): readonly (string | undefined)[] {
  return loop.snapshot().queue.map((item) => item.meta?.promptId);
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
      [active.id, [one.id, two.id]],
    ]);

    hold.release();
    await loop.settled();
  });

  it('reserves a messageId on prompt.steered and publishes turn.steer at materialize', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    const steered: PromptSteered[] = [];
    const events: TurnSteer[] = [];
    ctx.get(IEventBus).subscribe(PromptSteered, (event) => steered.push(event));
    ctx.get(IEventBus).subscribe(TurnSteer, (event) => events.push(event));

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const one = await enqueue(loop, { message: message('one') });
    const two = await enqueue(loop, { message: message('two') });

    await loop.steer([two.id, one.id]);
    expect(events).toHaveLength(0);
    expect(steered[0]?.messageId).toEqual(expect.any(String));
    expect(steered[0]?.promptIds).toEqual([one.id, two.id]);

    hold.release();
    await loop.settled();
    expect(events).toHaveLength(1);
    expect(events[0]?.input).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
    expect(events[0]?.messageId).toBe(steered[0]?.messageId);
    expect(events[0]?.promptIds).toEqual([one.id, two.id]);
  });

  it('keeps each steered prompt client metadata in FIFO order without adding it to model content', async () => {
    setup();
    const hold = holdNextStep();
    const eventBus = ctx.get(IEventBus);
    const events: TurnSteer[] = [];
    const submitted: PromptSubmitted[] = [];
    const queued: PromptQueued[] = [];
    const steered: PromptSteered[] = [];
    eventBus.subscribe(PromptSubmitted, (event) => submitted.push(event));
    eventBus.subscribe(PromptQueued, (event) => queued.push(event));
    eventBus.subscribe(PromptSteered, (event) => steered.push(event));
    eventBus.subscribe(TurnSteer, (event) => events.push(event));
    await enqueue(loop, { message: message('active') });
    await hold.started;
    const first = { composer: { version: 1, refId: 'first' } };
    const second = { composer: { version: 1, refId: 'second' } };
    const one = await enqueue(loop, { message: { ...message('one'), origin: { kind: 'user', clientMetadata: [first] } } });
    const two = await enqueue(loop, { message: { ...message('two'), origin: { kind: 'user', clientMetadata: [second] } } });
    await loop.steer([two.id, one.id]);
    await Promise.resolve();
    expect(events).toHaveLength(0);
    expect(submitted.find((event) => event.promptId === one.id)?.clientMetadata).toEqual([first]);
    expect(queued.find((event) => event.promptId === two.id)?.clientMetadata).toEqual([second]);
    expect(PromptSteered.schema.parse(steered[0]).promptIds).toEqual([one.id, two.id]);
    hold.release();
    await loop.settled();
    expect(events).toHaveLength(0);
    const merged = ctx
      .get(IAgentContextMemoryService)
      .get()
      .find(
        (entry) =>
          entry.role === 'user' &&
          entry.content.some((part) => part.type === 'text' && part.text === 'one') &&
          entry.content.some((part) => part.type === 'text' && part.text === 'two'),
      );
    expect(merged?.origin).toMatchObject({ kind: 'user', clientMetadata: [first, second] });
    expect(merged?.content).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
    expect(merged?.id).toBe(steered[0]?.messageId);
  });

  it('keeps plain inputs beside composer metadata in a mixed steer', async () => {
    setup();
    const hold = holdNextStep();
    const eventBus = ctx.get(IEventBus);
    const events: TurnSteer[] = [];
    eventBus.subscribe(TurnSteer, (event) => events.push(event));
    await enqueue(loop, { message: message('active') });
    await hold.started;
    const metadata = { display_text: 'Save button', kimi_code_composer: { version: 1 } };
    const one = await enqueue(loop, { message: message('[literal](example.md)') });
    const two = await enqueue(loop, { message: { ...message('browser wire'), origin: { kind: 'user', clientMetadata: [metadata] } } });
    const three = await enqueue(loop, { message: message('last instruction') });
    await loop.steer([three.id, two.id, one.id]);
    await Promise.resolve();
    expect(events).toHaveLength(0);
    hold.release();
    await loop.settled();
    expect(events).toHaveLength(0);
    const merged = ctx
      .get(IAgentContextMemoryService)
      .get()
      .find(
        (entry) =>
          entry.role === 'user' &&
          entry.content.some((part) => part.type === 'text' && part.text === 'browser wire'),
      );
    expect(merged?.origin).toMatchObject({ clientMetadata: [{ display_text: '[literal](example.md)' }, metadata, { display_text: 'last instruction' }] });
    expect(merged?.content).toEqual([{ type: 'text', text: '[literal](example.md)' }, { type: 'text', text: 'browser wire' }, { type: 'text', text: 'last instruction' }]);
  });

  it('publishes prompt identities before each steered user message', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    const events: (PromptSteered | TurnSteer)[] = [];
    ctx.get(IEventBus).subscribe(PromptSteered, (event) => events.push(event));
    ctx.get(IEventBus).subscribe(TurnSteer, (event) => events.push(event));

    const active = await enqueue(loop, { message: message('active') });
    await hold.started;
    const one = await enqueue(loop, { message: message('same text') });
    const two = await enqueue(loop, { message: message('same text') });
    await loop.steer([two.id, one.id]);
    const three = await enqueue(loop, { message: message('same text') });
    await loop.steer([three.id]);
    const reserved = events.filter((event) => event.type === 'prompt.steered');
    expect(reserved).toMatchObject([
      { type: 'prompt.steered', activePromptId: active.id, promptIds: [one.id, two.id] },
      { type: 'prompt.steered', activePromptId: active.id, promptIds: [three.id] },
    ]);
    expect(events.filter((event) => event.type === 'turn.steer')).toHaveLength(0);

    hold.release();
    await loop.settled();

    const materialized = events.filter((event) => event.type === 'turn.steer');
    expect(materialized).toMatchObject([
      { type: 'turn.steer', input: [{ type: 'text', text: 'same text' }, { type: 'text', text: 'same text' }] },
      { type: 'turn.steer', input: [{ type: 'text', text: 'same text' }] },
    ]);
    expect(materialized[0]?.messageId).toBe(reserved[0]?.messageId);
    expect(materialized[0]?.promptIds).toEqual([one.id, two.id]);
    expect(reserved[1]?.messageId).toBe(three.id);
    expect(materialized[1]?.messageId).toBe(three.id);
    expect(materialized[1]?.promptIds).toEqual([three.id]);
  });

  it('does not publish turn.steer when an unconsumed steer seeds the next turn after cancel', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'seeded turn' });
    const steerEvents: TurnSteer[] = [];
    ctx.get(IEventBus).subscribe(TurnSteer, (event) => steerEvents.push(event));

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const stop = await enqueue(loop, { message: message('stop') });
    await loop.steer([stop.id]);
    loop.cancel();
    hold.release();
    await loop.settled();

    expect(steerEvents).toHaveLength(0);
    const materializedStops = ctx
      .get(IAgentContextMemoryService)
      .get()
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

    const { id } = loop.submit(
      {
        message: { role: 'user', content: message('system').content },
        meta: { origin: { kind: 'injection', variant: 'test' } as PromptOrigin },
      },
      { steerIfActive: true },
    );
    const turn = await loop.promptHandle(id)!.launched;
    expect(loop.snapshot().queue).toEqual([]);
    expect(loop.snapshot().activePromptId).toBeUndefined();
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

  it('exposes the in-flight gate item in the queue snapshot', async () => {
    setup();
    ctx.mockNextResponse({ type: 'text', text: 'launched' });
    let releaseHook!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    loop.hooks.onBeforeSubmitPrompt.register('gate', async (_hookCtx, next) => {
      markEntered();
      await new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      await next();
    });

    const { id } = loop.submit({
      message: { role: 'user', content: message('launching').content },
      meta: { tracked: true },
    });
    await entered;
    expect(pendingIds(loop)).toEqual([id]);
    expect(loop.snapshot().activePromptId).toBeUndefined();
    releaseHook();
    await loop.promptHandle(id)!.launched;
    expect(loop.snapshot().queue).toHaveLength(0);
    await loop.settled();
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

    const history = ctx.context.get();
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
    vi.spyOn(ctx.get(IAgentProfileService), 'getModelProviderType').mockReturnValue(undefined);
    const avifUrl = `data:image/avif;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;

    await enqueue(loop, {
      id: 'prompt-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await hold.started;

    const appended = ctx.context.get();
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
    const heicUrl = `data:image/heic;base64,${Buffer.from([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]).toString('base64')}`;

    await enqueue(loop, {
      id: 'prompt-heic',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: heicUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await hold.started;

    const parts = ctx.context.get()[0]!.content;
    expect(parts).toEqual([{ type: 'image_url', imageUrl: { url: heicUrl } }]);

    hold.release();
    await loop.settled();
  });

  it('gates steered prompt images too', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    vi.spyOn(ctx.get(IAgentProfileService), 'getModelProviderType').mockReturnValue(undefined);

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const avifUrl = `data:image/avif;base64,${Buffer.from([4, 5, 6]).toString('base64')}`;
    const queued = await enqueue(loop, {
      id: 'prompt-steer-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await loop.steer([queued.id]);

    hold.release();
    await loop.settled();

    const parts = ctx.context.get().flatMap((entry) => entry.content);
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
        toolCalls: [],
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

    expect(steered).toHaveLength(1);
    expect(steered[0]).toEqual([
      { type: 'text', text: 'first user text' },
      { type: 'text', text: 'second user text' },
    ]);

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

    expect(queued).toEqual([
      { promptId: 'bundled', content: [{ type: 'text', text: 'user text' }] },
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

  it('keeps bundled skill blocks at the merged message prefix when steering', async () => {
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

    const merged = ctx.context.get().find(
      (entry) => entry.origin?.kind === 'user' && entry.origin.skillActivations !== undefined,
    );
    expect(merged?.content).toEqual([
      { type: 'text', text: '<skill>review</skill>' },
      { type: 'text', text: '<skill>security</skill>' },
      { type: 'text', text: 'user A' },
      { type: 'text', text: 'user B' },
    ]);
  });

  it('concatenates origin file attachments when steering queued prompts', async () => {
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
        toolCalls: [],
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
        toolCalls: [],
        origin: {
          kind: 'user',
          attachments: [{ name: 'b.txt', mediaType: 'text/plain', size: 2, path: '/data/b.txt' }],
        },
      },
    });

    await loop.steer([one.id, two.id]);
    hold.release();
    await loop.settled();

    const merged = ctx.context.get().find(
      (entry) => entry.origin?.kind === 'user' && entry.origin.attachments !== undefined,
    );
    expect(merged?.origin?.kind === 'user' && merged.origin.attachments).toEqual([
      { name: 'a.txt', mediaType: 'text/plain', size: 1, path: '/data/a.txt' },
      { name: 'b.txt', mediaType: 'text/plain', size: 2, path: '/data/b.txt' },
    ]);
    expect(merged?.origin?.kind === 'user' && merged.origin.skillActivations).toBeUndefined();
  });

  it('steers a fresh submission into the active turn and settles it with the parent', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    const steered: PromptSteered[] = [];
    ctx.get(IEventBus).subscribe(PromptSteered, (event) => steered.push(event));

    const active = await enqueue(loop, { message: message('active') });
    await hold.started;
    const { id } = loop.submit(
      {
        message: { role: 'user', content: message('steer me').content },
        meta: { tracked: true },
      },
      { steerIfActive: true },
    );
    const handle = loop.promptHandle(id)!;

    expect(steered.map((event) => [event.activePromptId, event.promptIds])).toEqual([
      [active.id, [id]],
    ]);
    expect(handle.state).toBe('steered');
    await expect(handle.launched).resolves.toBeDefined();

    hold.release();
    await expect(handle.completion).resolves.toMatchObject({ state: 'completed' });
    await loop.settled();
  });

  it('carries submit metadata on the queue snapshot', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });

    await enqueue(loop, { message: message('active') });
    await hold.started;
    const { id } = loop.submit({
      message: { role: 'user', content: message('meta').content },
      meta: { promptId: 'meta-id', tracked: true },
    });

    expect(loop.snapshot().queue).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({
          promptId: 'meta-id',
          origin: { kind: 'user' },
          tracked: true,
          userMessageId: 'meta-id',
        }),
      }),
    ]);
    expect(loop.snapshot().queue[0]?.meta?.createdAt).not.toBe('');

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
