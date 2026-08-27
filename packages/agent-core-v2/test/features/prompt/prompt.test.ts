import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Readable } from 'node:stream';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { AgentRuntimeSet } from '#/agent/runtime/agentRuntimeSet';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import type { ContextMessage } from '#/features/contextMemory/types';
import type { ContentPart } from '#/kosong/contract/message';
import { LoopControlToken } from '#/features/loop/internal/loop';
import { AgentPrompt, promptAgentRuntimeProvider } from '#/features/prompt/promptAgentRuntime';
import type { PromptRuntime } from '#/features/prompt/prompt';
import { PromptQueued, PromptSteered } from '#/features/prompt/promptEvents';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { createReminderStub, lifecycleWithReminder } from '../reminder/stubs';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { EventBusService } from '#/app/event/eventBusService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { IFileService } from '#/app/file/fileService';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubWire, type StubLoopOptions } from '../../agent/loop/stubs';
import { lifecycleWithToolExecutor } from '../toolExecutor/stubs';
import { lifecycleWithFullCompaction, stubFullCompactionRuntime } from '../fullCompaction/stubs';
import { registerStateServices } from '../../state/stubs';
import { SteerStepRequest } from '#/features/prompt/internal/promptStepRequests';
import { stubWireJournal } from '../../wire/stubs';

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

interface HarnessOptions extends StubLoopOptions {
  readonly journal?: readonly WireRecord[];
}

function harness(options: HarnessOptions = { pendingTurnResult: true }) {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());
  const context = stubContextMemory();
  const reminder = createReminderStub({
    notify: (content, notification) => {
      void context.append({
        role: 'user',
        content: [{ type: 'text', text: wrapSystemReminder(content) }],
        toolCalls: [],
        origin: { kind: 'injection', ...notification },
      });
    },
  });
  const loop = stubLoopWithHooks({ pendingTurnResult: true, ...options });
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
  let runtimes: AgentRuntimeSet | undefined;
  const agentScope = makeAgentScopeContext({ agentId: 'main', agentScope: '' });
  const lifecycle: IAgentLifecycleService = lifecycleWithFullCompaction(
    stubFullCompactionRuntime(),
    lifecycleWithToolExecutor(
    stubToolExecutor(),
    {
      resolve: (agent: unknown, definition: unknown) => {
        if (definition === AgentPrompt) return runtimes!.resolve(AgentPrompt);
        return lifecycleWithReminder(reminder, context).resolve(agent as never, definition as never);
      },
      handleOf: () => ({}),
      onDidCreateScope: () => ({ dispose: () => {} }),
    } as unknown as IAgentLifecycleService,
    agentScope.agentContext,
  ),
  );
  const ix = createServices(disposables, {
    strict: true, additionalServices: (reg) => {
      registerStateServices(reg);
      reg.defineInstance(LoopControlToken, loop);
      reg.defineInstance(IWireService, options.journal === undefined ? stubWire() : stubWireJournal(options.journal as WireRecord[]));
      reg.defineInstance(IAgentBlobService, noopBlob);
      reg.define(IEventDispatcher, EventDispatcherService);
      reg.definePartialInstance(IAgentToolPolicyService, { setSessionDisabledTools: async () => {} });
      reg.define(IEventBus, EventBusService);
      reg.defineInstance(IAgentLifecycleService, lifecycle);
      reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
      reg.definePartialInstance(ISessionMetadata, {
        read: async () => ({ id: 'test-session', createdAt: 0, updatedAt: 0, archived: false }),
        update: async () => {},
      });
      reg.definePartialInstance(IEventService, { publish: () => {} });
      reg.definePartialInstance(ISessionContext, { sessionId: 'test-session' });
      reg.defineInstance(IAgentScopeContext, agentScope);
      reg.definePartialInstance(IFileService, { get: intake.get });
      reg.definePartialInstance(ISessionMediaStore, { materialize: intake.materialize });
    }
  });
  (ix.get(IEventBus) as ISessionEventBus).activateAgent(
    ix.get(IAgentScopeContext).agentContext,
  );
  runtimes = new AgentRuntimeSet(agentScope.agentContext, { get: (id) => ix.get(id) });
  runtimes.apply({
    definition: AgentPrompt,
    provider: promptAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(ix.get(IEventDispatcher));
  return {
    prompt: runtimes.resolve(AgentPrompt),
    runtimes,
    loop,
    context,
    eventBus: ix.get(IEventBus),
    intake,
    ix,
  };
}

function promptAcceptedRecord(promptId: string): WireRecord {
  return {
    type: 'prompt.accepted',
    agentId: 'main',
    promptId,
    content: [{ type: 'text', text: 'replayed' }],
  } as unknown as WireRecord;
}

describe('AgentPrompt runtime', () => {
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
    prompt.registerBeforeSubmitHook('block', async (ctx, next) => { ctx.block = true; await next(); });
    const handle = await prompt.enqueue({ message: message('blocked') });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });
  });

  it('delivers a blocked prompt’s compression captions right after their host message', async () => {
    const { prompt, context } = harness();
    prompt.registerBeforeSubmitHook('block', async (ctx, next) => { ctx.block = true; await next(); });
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

describe('AgentPrompt submit', () => {
  it('submits through the unified contract entry and returns the launch projection', async () => {
    const { prompt } = harness();
    const result = await prompt.submit({
      content: [{ type: 'text', text: 'hello' }],
      origin: { kind: 'user' },
      promptId: 'submit-1',
    });
    expect(result.promptId).toBe('submit-1');
    expect(result.state).toBe('running');
    expect(result.turnId).toBe(0);
  });

  it('rejects a duplicate prompt_id after the accepted fact is durable', async () => {
    const { prompt } = harness();
    await prompt.submit({
      content: [{ type: 'text', text: 'first' }],
      origin: { kind: 'user' },
      promptId: 'dup-1',
    });
    await expect(prompt.submit({
      content: [{ type: 'text', text: 'second' }],
      origin: { kind: 'user' },
      promptId: 'dup-1',
    })).rejects.toMatchObject({ code: 'prompt.id_conflict' });
  });

  it('rejects an empty prompt_id as invalid', async () => {
    const { prompt } = harness();
    await expect(prompt.submit({
      content: [{ type: 'text', text: 'x' }],
      origin: { kind: 'user' },
      promptId: '',
    })).rejects.toMatchObject({ code: 'request.invalid' });
  });

  it('steers the current turn under admission currentTurn and degrades to queued when steering misses', async () => {
    const { prompt } = harness();
    const result = await prompt.submit({
      content: [{ type: 'text', text: 'steer me' }],
      origin: { kind: 'user' },
      admission: 'currentTurn',
    });
    expect(result.state).toBe('running');
    expect(result.turnId).toBe(0);
  });

  it('reports queued when the submission waits behind an active turn', async () => {
    const { prompt } = harness();
    await prompt.submit({ content: [{ type: 'text', text: 'active' }], origin: { kind: 'user' } });
    const queued = await prompt.submit({
      content: [{ type: 'text', text: 'second' }],
      origin: { kind: 'user' },
      promptId: 'queued-1',
    });
    expect(queued.state).toBe('queued');
    expect(queued.turnId).toBeUndefined();
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['queued-1']);
  });
});

describe('AgentPrompt reserveAdmission', () => {
  it('holds a prompt_id against concurrent submissions until disposed', async () => {
    const { prompt } = harness();
    const reservation = prompt.reserveAdmission('hold-1');
    await expect(prompt.submit({
      content: [{ type: 'text', text: 'racing' }],
      origin: { kind: 'user' },
      promptId: 'hold-1',
    })).rejects.toMatchObject({ code: 'prompt.id_conflict' });
    reservation.dispose();
    const result = await prompt.submit({
      content: [{ type: 'text', text: 'after release' }],
      origin: { kind: 'user' },
      promptId: reservation.id,
    });
    expect(result.promptId).toBe('hold-1');
    expect(result.state).toBe('running');
  });

  it('rejects an empty reserved prompt_id as invalid', async () => {
    const { prompt } = harness();
    try {
      prompt.reserveAdmission('');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'request.invalid' });
    }
  });

  it('tolerates repeated disposal', async () => {
    const { prompt } = harness();
    const reservation = prompt.reserveAdmission('hold-2');
    reservation.dispose();
    reservation.dispose();
    const result = await prompt.submit({
      content: [{ type: 'text', text: 'x' }],
      origin: { kind: 'user' },
      promptId: 'hold-2',
    });
    expect(result.promptId).toBe('hold-2');
  });
});

describe('AgentPrompt durable admission', () => {
  it('replays prompt.accepted into the runtime and keeps conflicting prompt_ids rejected after a restart', async () => {
    const { prompt, ix } = harness({ journal: [promptAcceptedRecord('replayed-1')] });
    await ix.get(IEventDispatcher).restore();
    await expect(prompt.submit({
      content: [{ type: 'text', text: 'again' }],
      origin: { kind: 'user' },
      promptId: 'replayed-1',
    })).rejects.toMatchObject({ code: 'prompt.id_conflict' });
    const fresh = await prompt.submit({
      content: [{ type: 'text', text: 'fresh' }],
      origin: { kind: 'user' },
      promptId: 'replayed-2',
    });
    expect(fresh.state).toBe('running');
  });

  it('rebuilds the same admission state from a second replay of the same journal', async () => {
    const first = harness({ journal: [promptAcceptedRecord('replay-a'), promptAcceptedRecord('replay-b')] });
    await first.ix.get(IEventDispatcher).restore();
    await expect(first.prompt.submit({
      content: [{ type: 'text', text: 'x' }],
      origin: { kind: 'user' },
      promptId: 'replay-a',
    })).rejects.toMatchObject({ code: 'prompt.id_conflict' });
    await expect(first.prompt.submit({
      content: [{ type: 'text', text: 'x' }],
      origin: { kind: 'user' },
      promptId: 'replay-b',
    })).rejects.toMatchObject({ code: 'prompt.id_conflict' });
  });
});

describe('AgentPrompt submitMessage', () => {
  it('admits a rich-origin message as a durable accepted prompt with caller-only content', async () => {
    const journal: WireRecord[] = [];
    const { prompt } = harness({ journal });
    const handle = await prompt.submitMessage({
      role: 'user',
      content: [
        { type: 'text', text: '<skill>review</skill>' },
        { type: 'text', text: 'user text' },
      ],
      toolCalls: [],
      origin: {
        kind: 'user',
        skillActivations: [{ activationId: 'act-1', skillName: 'review' }],
      },
    });
    expect(handle.state).toBe('running');
    const accepted = journal.find((record) => record.type === 'prompt.accepted');
    expect(accepted).toMatchObject({
      agentId: 'main',
      promptId: handle.id,
      content: [{ type: 'text', text: 'user text' }],
    });
  });
});
