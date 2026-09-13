import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IFileService } from '#/app/file/fileService';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
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

    const handle = await loop.enqueuePrompt({ id: 'prompt-1', message: message('hello') });
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

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const first = await loop.enqueuePrompt({ message: message('one') });
    const second = await loop.enqueuePrompt({ message: message('two') });
    expect(loop.promptQueue().pending.map((item) => item.id)).toEqual([first.id, second.id]);

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

    await loop.enqueuePrompt({ id: 'active', message: message('active') });
    await hold.started;
    expect(queued).toEqual([]);

    await loop.enqueuePrompt({ id: 'waiting', message: message('waiting') });
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

    const active = await loop.enqueuePrompt({ id: 'active', message: message('active') });
    expect(submitted).toEqual([
      { promptId: 'active', userMessageId: 'active', status: 'running', content: [{ type: 'text', text: 'active' }] },
    ]);
    await active.launched;
    expect(started).toEqual(['active']);

    await loop.enqueuePrompt({ id: 'waiting', message: message('waiting') });
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

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const queued = await loop.enqueuePrompt({ message: message('one') });
    await expect(loop.steerPrompts([queued.id, 'missing'])).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(loop.promptQueue().pending.map((item) => item.id)).toEqual([queued.id]);

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

    const active = await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const one = await loop.enqueuePrompt({ message: message('one') });
    const two = await loop.enqueuePrompt({ message: message('two') });
    const handles = await loop.steerPrompts([two.id, one.id]);
    expect(handles.map((item) => item.id)).toEqual([one.id, two.id]);
    expect(steered.map((event) => [event.activePromptId, event.promptIds])).toEqual([
      [active.id, [one.id, two.id]],
    ]);

    hold.release();
    await loop.settled();
  });

  it('publishes turn.steer at materialize time without altering the wire payload shape', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });
    const events: TurnSteer[] = [];
    ctx.get(IEventBus).subscribe(TurnSteer, (event) => events.push(event));

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const one = await loop.enqueuePrompt({ message: message('one') });
    const two = await loop.enqueuePrompt({ message: message('two') });

    await loop.steerPrompts([two.id, one.id]);
    expect(events).toHaveLength(0);

    hold.release();
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events[0]?.input).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
    expect(events[0]).not.toHaveProperty('messageId');
    expect(events[0]).not.toHaveProperty('promptIds');
    await loop.settled();
  });

  it('aborts pending prompts and settles completion', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    const aborted: PromptAborted[] = [];
    ctx.get(IEventBus).subscribe(PromptAborted, (event) => aborted.push(event));

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const handle = await loop.enqueuePrompt({ message: message('queued') });
    expect(loop.abortPrompt(handle.id)).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(loop.promptQueue().pending).toEqual([]);
    expect(aborted.map((event) => event.promptId)).toEqual([handle.id]);

    hold.release();
    await loop.settled();
  });

  it('keeps injections outside the prompt queue', async () => {
    setup();
    ctx.mockNextResponse({ type: 'text', text: 'injected' });

    const turn = await loop.injectPrompt({ ...message('system'), origin: { kind: 'injection', variant: 'test' } });
    expect(loop.promptQueue()).toEqual({ active: undefined, pending: [], launching: false });
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

    const handle = await loop.enqueuePrompt({ message: message('blocked') });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });
    expect(completed.map((event) => [event.promptId, event.reason])).toEqual([[handle.id, 'blocked']]);
  });

  it('marks the launch window as busy in the queue snapshot', async () => {
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

    const enqueued = loop.enqueuePrompt({ message: message('launching') });
    await entered;
    expect(loop.promptQueue().launching).toBe(true);
    expect(loop.promptQueue().active).toBeUndefined();
    expect(loop.promptQueue().pending).toEqual([]);
    releaseHook();
    await enqueued;
    expect(loop.promptQueue().launching).toBe(false);
    await loop.settled();
  });

  it('delivers a blocked prompt’s compression captions right after their host message', async () => {
    setup();
    loop.hooks.onBeforeSubmitPrompt.register('block', async (hookCtx, next) => {
      hookCtx.block = true;
      await next();
    });

    const handle = await loop.enqueuePrompt({
      id: 'prompt-caption',
      message: message('<system>Image compressed to fit model limits: 800x600</system>look at this'),
    });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });

    const history = ctx.context.get();
    expect(history).toHaveLength(2);
    expect(history[0]?.origin).toEqual({
      kind: 'injection',
      variant: 'image_compression',
      ownerPromptId: 'prompt-caption',
    });
    expect(history[1]?.origin).toEqual({ kind: 'user' });
    expect(history[1]?.content).toEqual([{ type: 'text', text: 'look at this' }]);
    const captionPart = history[0]?.content[0];
    expect(captionPart?.type).toBe('text');
    expect((captionPart as { text: string }).text).toContain(
      'Image compressed to fit model limits: 800x600',
    );
  });

  it('settles the prompt as failed when the launch pipeline throws', async () => {
    setup();
    loop.hooks.onBeforeSubmitPrompt.register('explode', () => {
      throw new Error('boom');
    });

    const handle = await loop.enqueuePrompt({ id: 'prompt-x', message: message('hello') });
    expect(handle.state).toBe('failed');
    await expect(handle.launched).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({ state: 'failed', result: undefined });
    expect(loop.promptQueue()).toEqual({ active: undefined, pending: [], launching: false });
  });

  it('replaces an unsupported prompt image with a text notice at the history funnel', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'seen' });
    vi.spyOn(ctx.get(IAgentProfileService), 'getModelProviderType').mockReturnValue(undefined);
    const avifUrl = `data:image/avif;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;

    await loop.enqueuePrompt({
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

    await loop.enqueuePrompt({
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

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const avifUrl = `data:image/avif;base64,${Buffer.from([4, 5, 6]).toString('base64')}`;
    const queued = await loop.enqueuePrompt({
      id: 'prompt-steer-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await loop.steerPrompts([queued.id]);

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

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const queued = await loop.enqueuePrompt({
      id: 'prompt-steer-daemon',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: 'kimi-file://file_1' } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    await loop.steerPrompts([queued.id]);

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

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const one = await loop.enqueuePrompt({ message: bundledMessage('review', 'first user text') });
    const two = await loop.enqueuePrompt({ message: bundledMessage('security', 'second user text') });

    await loop.steerPrompts([one.id, two.id]);

    expect(steered).toHaveLength(1);
    expect(steered[0]).toEqual([
      { type: 'text', text: 'first user text' },
      { type: 'text', text: 'second user text' },
    ]);

    hold.release();
    await loop.settled();
  });

  it('restores failed steers to their original queue positions', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'a' });
    ctx.mockNextResponse({ type: 'text', text: 'b' });
    ctx.mockNextResponse({ type: 'text', text: 'c' });

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    await loop.enqueuePrompt({ id: 'a', message: message('a') });
    await loop.enqueuePrompt({ id: 'b', message: message('b') });
    await loop.enqueuePrompt({ id: 'c', message: message('c') });
    vi.spyOn(loop, 'steer').mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(loop.steerPrompts(['b'])).rejects.toMatchObject({ code: 'prompt.not_found' });

    expect(loop.promptQueue().pending.map((item) => item.id)).toEqual(['a', 'b', 'c']);

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

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;

    await loop.enqueuePrompt({ id: 'bundled', message: bundledMessage('review', 'user text') });

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

    await loop.enqueuePrompt({ message: message('active') });
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
    await loop.enqueuePrompt({
      id: 'a',
      message: bundledMessage('review', 'a text', [
        { type: 'image_url', imageUrl: { url: 'kimi-file://file_1' } },
      ]),
    });
    await loop.enqueuePrompt({ id: 'b', message: message('b') });

    const steerPromise = loop.steerPrompts(['a', 'b']);
    loop.abortPrompt('a');
    releaseIntake();

    await expect(steerPromise).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(loop.promptQueue().pending.map((item) => item.id)).toEqual(['b']);

    hold.release();
    await loop.settled();
  });

  it('keeps bundled skill blocks at the merged message prefix when steering', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'merged' });

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const one = await loop.enqueuePrompt({ message: bundledMessage('review', 'user A') });
    const two = await loop.enqueuePrompt({ message: bundledMessage('security', 'user B') });

    await loop.steerPrompts([one.id, two.id]);
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

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const one = await loop.enqueuePrompt({
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
    const two = await loop.enqueuePrompt({
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

    await loop.steerPrompts([one.id, two.id]);
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

  it('restarts the queue after a failed steer once the active turn settles', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'queued' });

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const queued = await loop.enqueuePrompt({ id: 'queued', message: message('queued') });
    vi.spyOn(loop, 'steer').mockImplementation(() => {
      throw new Error('held');
    });

    await expect(loop.steerPrompts([queued.id])).rejects.toMatchObject({ code: 'prompt.not_found' });

    hold.release();
    await expect(queued.launched).resolves.toBeDefined();
    expect(loop.promptQueue().active?.id).toBe('queued');
    await loop.settled();
  });

  it('restores the original queue order when a steer assignment fails', async () => {
    setup();
    const hold = holdNextStep();
    ctx.mockNextResponse({ type: 'text', text: 'active' });
    ctx.mockNextResponse({ type: 'text', text: 'a' });
    ctx.mockNextResponse({ type: 'text', text: 'b' });

    await loop.enqueuePrompt({ message: message('active') });
    await hold.started;
    const a = await loop.enqueuePrompt({ id: 'a', message: message('a') });
    await loop.enqueuePrompt({ id: 'b', message: message('b') });
    vi.spyOn(loop, 'steer').mockImplementation(() => {
      throw new Error('held');
    });

    await expect(loop.steerPrompts([a.id])).rejects.toMatchObject({ code: 'prompt.not_found' });
    hold.release();

    await expect(a.launched).resolves.toBeDefined();
    expect((await a.launched)?.id).toBe(1);
    expect(loop.promptQueue().active?.id).toBe('a');
    expect(loop.promptQueue().pending.map((item) => item.id)).toEqual(['b']);
    await loop.settled();
  });
});
