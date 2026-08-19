import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Readable } from 'node:stream';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService, PromptQueued, PromptSteered } from '#/agent/prompt/promptService';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { EventBusService } from '#/app/event/eventBusService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { IWireService } from '#/wire/wire';
import { IFileService } from '#/app/file/fileService';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubWire, type StubLoopOptions } from '../loop/stubs';
import { registerStateServices } from '../../state/stubs';
import { SteerStepRequest } from '#/agent/prompt/promptStepRequests';

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

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function harness(loopOptions: StubLoopOptions = { pendingTurnResult: true }) {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());
  const context = stubContextMemory();
  const loop = stubLoopWithHooks(loopOptions);
  const fullCompaction = {
    _serviceBrand: undefined,
    compacting: null,
    begin: () => false,
    hooks: createHooks(['onWillCompact']),
    onDidFinishCompaction: Event.None,
  } as unknown as IAgentFullCompactionService;
  const intake = {
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
  const ix = createServices(disposables, {
    strict: true, additionalServices: (reg) => {
      registerStateServices(reg);
      reg.defineInstance(IAgentContextMemoryService, context);
      reg.defineInstance(IAgentLoopService, loop);
      reg.defineInstance(IWireService, stubWire());
      reg.defineInstance(IAgentBlobService, noopBlob);
      reg.define(IEventDispatcher, EventDispatcherService);
      reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
      reg.definePartialInstance(IAgentToolPolicyService, { setSessionDisabledTools: async () => {} });
      reg.defineInstance(IAgentFullCompactionService, fullCompaction);
      reg.define(IEventBus, EventBusService);
      reg.define(IAgentSystemReminderService, AgentSystemReminderService);
      reg.define(IAgentPromptService, AgentPromptService);
      reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
      reg.definePartialInstance(ISessionMetadata, {
        read: async () => ({ id: 'test-session', createdAt: 0, updatedAt: 0, archived: false }),
        update: async () => {},
      });
      reg.definePartialInstance(IEventService, { publish: () => {} });
      reg.definePartialInstance(ISessionContext, { sessionId: 'test-session' });
      reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
      reg.definePartialInstance(IFileService, { get: intake.get });
      reg.definePartialInstance(ISessionMediaStore, { materialize: intake.materialize });
    }
  });
  return { prompt: ix.get(IAgentPromptService), loop, context, fullCompaction, eventBus: ix.get(IEventBus), intake };
}

describe('AgentPromptService', () => {
  it('assigns stable identity and launches an idle prompt', async () => {
    const { prompt } = harness();
    const handle = await prompt.enqueue({ id: 'prompt-1', message: message('hello') });
    expect(handle.id).toBe('prompt-1');
    expect(handle.userMessageId).toBe('prompt-1');
    expect((await handle.launched)?.id).toBe(0);
  });

  it('keeps later prompts in FIFO order while active', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const first = await prompt.enqueue({ message: message('one') });
    const second = await prompt.enqueue({ message: message('two') });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it('publishes prompt.queued only for prompts that cannot launch immediately', async () => {
    const { prompt, eventBus } = harness();
    const queued: Array<{ promptId: string; queueLength: number }> = [];
    eventBus.subscribe(PromptQueued, (e) => {
      queued.push({ promptId: e.promptId, queueLength: e.queueLength });
    });

    await prompt.enqueue({ id: 'active', message: message('active') });
    expect(queued).toEqual([]);

    await prompt.enqueue({ id: 'waiting', message: message('waiting') });
    expect(queued).toEqual([{ promptId: 'waiting', queueLength: 1 }]);
  });

  it('atomically rejects steer when any id is not pending', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('one') });
    await expect(prompt.steer([queued.id, 'missing'])).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([queued.id]);
  });

  it('steers selected prompts in FIFO order', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: message('one') });
    const two = await prompt.enqueue({ message: message('two') });
    const handles = await prompt.steer([two.id, one.id]);
    expect(handles.map((item) => item.id)).toEqual([one.id, two.id]);
    loop.drainNextBatch(context);
  });

  it('aborts pending prompts and settles completion', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const handle = await prompt.enqueue({ message: message('queued') });
    expect(prompt.abort(handle.id)).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(prompt.list().pending).toEqual([]);
  });

  it('keeps injections outside the prompt queue', async () => {
    const { prompt } = harness();
    await prompt.inject({ ...message('system'), origin: { kind: 'injection', variant: 'test' } });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('settles blocked prompts', async () => {
    const { prompt } = harness();
    prompt.hooks.onBeforeSubmitPrompt.register('block', async (ctx, next) => { ctx.block = true; await next(); });
    const handle = await prompt.enqueue({ message: message('blocked') });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });
  });

  it('delivers a blocked prompt’s compression captions right after their host message', async () => {
    const { prompt, context } = harness();
    prompt.hooks.onBeforeSubmitPrompt.register('block', async (ctx, next) => { ctx.block = true; await next(); });
    const handle = await prompt.enqueue({
      id: 'prompt-caption',
      message: message(
        '<system>Image compressed to fit model limits: 800x600</system>look at this',
      ),
    });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });

    const history = context.get();
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

  it('settles the prompt as failed when the loop throws on launch', async () => {
    const { prompt, loop } = harness();
    vi.spyOn(loop, 'enqueue').mockImplementation(() => {
      throw new Error2(ErrorCodes.TURN_AGENT_BUSY, 'Cannot launch a new turn while another turn is active');
    });
    const handle = await prompt.enqueue({ id: 'prompt-x', message: message('hello') });
    expect(handle.state).toBe('failed');
    await expect(handle.launched).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({ state: 'failed', result: undefined });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('replaces an unsupported prompt image with a text notice at the history funnel', async () => {
    const { prompt, context, loop } = harness();
    const avifUrl = `data:image/avif;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
    const handle = await prompt.enqueue({
      id: 'prompt-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await handle.launched;
    loop.drainNextBatch(context);

    const appended = context.get();
    expect(appended).toHaveLength(1);
    const parts = appended[0]!.content;
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('image/avif');
  });

  it('gates steered prompt images too', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const avifUrl = `data:image/avif;base64,${Buffer.from([4, 5, 6]).toString('base64')}`;
    const queued = await prompt.enqueue({
      id: 'prompt-steer-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await prompt.steer([queued.id]);
    loop.drainNextBatch(context);

    const appended = context.get();
    const parts = appended.flatMap((entry) => entry.content);
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(
      parts.some((part) => part.type === 'text' && part.text.includes('image/avif')),
    ).toBe(true);
  });

  it('materializes daemon-ref media at steer intake', async () => {
    const { prompt, intake } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'prompt-steer-daemon',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: 'kimi-file://file_1' } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    await prompt.steer([queued.id]);

    expect(intake.get).toHaveBeenCalledWith('file_1');
    expect(intake.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file_1', name: 'pic.png' }),
    );
  });

  it('publishes each record’s user parts when steering bundled prompts', async () => {
    const { prompt, eventBus } = harness();
    const steered: ContentPart[][] = [];
    eventBus.subscribe(PromptSteered, (event) => steered.push(event.content));
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: bundledMessage('review', 'first user text') });
    const two = await prompt.enqueue({ message: bundledMessage('security', 'second user text') });

    await prompt.steer([one.id, two.id]);

    expect(steered).toHaveLength(1);
    expect(steered[0]).toEqual([
      { type: 'text', text: 'first user text' },
      { type: 'text', text: 'second user text' },
    ]);
  });

  it('restores failed steers to their original queue positions', async () => {
    const { prompt, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    await prompt.enqueue({ id: 'a', message: message('a') });
    await prompt.enqueue({ id: 'b', message: message('b') });
    await prompt.enqueue({ id: 'c', message: message('c') });
    vi.spyOn(loop, 'enqueue').mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(prompt.steer(['b'])).rejects.toMatchObject({ code: 'prompt.not_found' });

    expect(prompt.list().pending.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('publishes only caller parts when a bundled prompt queues', async () => {
    const { prompt, eventBus } = harness();
    const queued: Array<{ promptId: string; content: ContentPart[] }> = [];
    eventBus.subscribe(PromptQueued, (event) => {
      queued.push({ promptId: event.promptId, content: event.content });
    });
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;

    await prompt.enqueue({ id: 'bundled', message: bundledMessage('review', 'user text') });

    expect(queued).toEqual([
      { promptId: 'bundled', content: [{ type: 'text', text: 'user text' }] },
    ]);
  });

  it('rejects the whole steer when a selected prompt is aborted during intake', async () => {
    const { prompt, intake } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    let releaseIntake!: () => void;
    intake.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseIntake = () =>
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
        }),
    );
    await prompt.enqueue({
      id: 'a',
      message: bundledMessage('review', 'a text', [
        { type: 'image_url', imageUrl: { url: 'kimi-file://file_1' } },
      ]),
    });
    await prompt.enqueue({ id: 'b', message: message('b') });

    const steerPromise = prompt.steer(['a', 'b']);
    prompt.abort('a');
    releaseIntake();

    await expect(steerPromise).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['b']);
  });

  it('keeps bundled skill blocks at the merged message prefix when steering', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: bundledMessage('review', 'user A') });
    const two = await prompt.enqueue({ message: bundledMessage('security', 'user B') });

    await prompt.steer([one.id, two.id]);
    loop.drainNextBatch(context);

    const merged = context
      .get()
      .find(
        (entry) => entry.origin?.kind === 'user' && entry.origin.skillActivations !== undefined,
      );
    expect(merged?.content).toEqual([
      { type: 'text', text: '<skill>review</skill>' },
      { type: 'text', text: '<skill>security</skill>' },
      { type: 'text', text: 'user A' },
      { type: 'text', text: 'user B' },
    ]);
  });

  it('restarts the queue after restoring a steer raced by the active turn settling', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({ id: 'queued', message: message('queued') });
    let steerEnqueued!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      steerEnqueued = resolve;
    });
    let rejectSteer!: (reason?: unknown) => void;
    const original = loop.enqueue.bind(loop);
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      if (request instanceof SteerStepRequest) {
        return {
          assigned: new Promise<never>((_, reject) => {
            rejectSteer = reject;
            steerEnqueued();
          }),
          abort: () => true,
        };
      }
      return original(request, options);
    });

    const steerPromise = prompt.steer([queued.id]);
    await enqueued;
    loop.settleActive();
    rejectSteer(new Error('held'));

    await expect(steerPromise).rejects.toMatchObject({ code: 'prompt.not_found' });
    await expect(queued.launched).resolves.toBeDefined();
    expect(prompt.list().active?.id).toBe('queued');
  });

  it('does not advance the queue while a steer assignment is in flight', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const a = await prompt.enqueue({ id: 'a', message: message('a') });
    await prompt.enqueue({ id: 'b', message: message('b') });
    let steerEnqueued!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      steerEnqueued = resolve;
    });
    let rejectSteer!: (reason?: unknown) => void;
    const original = loop.enqueue.bind(loop);
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      if (request instanceof SteerStepRequest) {
        return {
          assigned: new Promise<never>((_, reject) => {
            rejectSteer = reject;
            steerEnqueued();
          }),
          abort: () => true,
        };
      }
      return original(request, options);
    });

    const steerPromise = prompt.steer([a.id]);
    await enqueued;
    loop.settleActive();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(loop.launches).toHaveLength(1);
    rejectSteer(new Error('held'));

    await expect(steerPromise).rejects.toMatchObject({ code: 'prompt.not_found' });
    await expect(a.launched).resolves.toBeDefined();
    expect(prompt.list().active?.id).toBe('a');
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['b']);
  });
});
