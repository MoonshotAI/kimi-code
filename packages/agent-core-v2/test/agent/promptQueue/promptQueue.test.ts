import { afterEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { IAgentFullCompactionService, type FullCompactionInput } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptQueueService, type PromptQueueSnapshot } from '#/agent/promptQueue/promptQueue';
import { ErrorCodes } from '#/errors';
import { ISessionRunGate } from '#/session/sessionActivity/sessionRunGate';
import { IWireService } from '#/wire/wire';
import type { UserEntry } from '#human/agent/turn';

import {
  agentService,
  createTestAgent,
  type TestAgentContext,
  type TestAgentServiceOverride,
} from '../../harness';

function entry(id: string, text: string): UserEntry {
  return {
    message: { role: 'user', content: [{ type: 'text', text }] },
    meta: { promptId: id, origin: { kind: 'user' }, tracked: true },
  };
}

function ids(snapshot: PromptQueueSnapshot): string[] {
  return snapshot.items.map((item) => `${item.id}:${item.delivery}`);
}

describe('AgentPromptQueueService', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let queue: IAgentPromptQueueService;
  let launched: string[];

  afterEach(async () => {
    await ctx.dispose();
  });

  function setup(...overrides: TestAgentServiceOverride[]): void {
    ctx = createTestAgent(...overrides);
    loop = ctx.get(IAgentLoopService);
    queue = ctx.get(IAgentPromptQueueService);
    launched = [];
    loop.hooks.onBeforeSubmitPrompt.register('test-record-launch', async (hookCtx, next) => {
      const text = hookCtx.promptMessage.content.find((part) => part.type === 'text');
      launched.push(text?.type === 'text' ? text.text : '');
      await next();
    });
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
    return { started, release: () => releaseGate() };
  }

  function respond(count: number): void {
    for (let index = 0; index < count; index += 1) {
      ctx.mockNextResponse({ type: 'text', text: `reply ${index}` });
    }
  }

  async function startHeldTurn(): Promise<() => void> {
    const hold = holdNextStep();
    const first = await queue.submitInput({ id: 'p1', entry: entry('p1', 'first'), delivery: 'queue' });
    expect(first.acceptedAs).toBe('turn');
    await hold.started;
    return hold.release;
  }

  it('launches an idle input as a turn without queueing it', async () => {
    setup();
    respond(1);

    const result = await queue.submitInput({ id: 'p1', entry: entry('p1', 'hello'), delivery: 'queue' });

    expect(result.acceptedAs).toBe('turn');
    expect(result.handle?.id).toBe('p1');
    expect(queue.snapshot().items).toEqual([]);
    await loop.settled();
    expect(launched).toEqual(['hello']);
  });

  it('queues inputs while a turn runs and starts each one after the previous turn ends', async () => {
    setup();
    respond(3);
    const release = await startHeldTurn();

    const second = await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue' });
    const third = await queue.submitInput({ id: 'p3', entry: entry('p3', 'third'), delivery: 'queue' });

    expect(second.acceptedAs).toBe('queue');
    expect(third.acceptedAs).toBe('queue');
    expect(ids(queue.snapshot())).toEqual(['p2:queue', 'p3:queue']);
    expect(loop.snapshot().queue).toEqual([]);

    release();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second', 'third']));
    await loop.settled();
    expect(queue.snapshot().items).toEqual([]);
  });

  it('holds queued inputs and new submissions while paused until it resumes', async () => {
    setup();
    respond(3);
    const release = await startHeldTurn();
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue' });
    queue.pause();

    release();
    await loop.settled();
    await Promise.resolve();
    expect(launched).toEqual(['first']);
    expect(queue.snapshot()).toMatchObject({ paused: true });

    const held = await queue.submitInput({ id: 'p3', entry: entry('p3', 'third'), delivery: 'queue' });
    expect(held.acceptedAs).toBe('queue');
    await Promise.resolve();
    expect(launched).toEqual(['first']);
    expect(ids(queue.snapshot())).toEqual(['p2:queue', 'p3:queue']);

    queue.resume();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second', 'third']));
    await loop.settled();
  });

  it('does not keep undo-style quiescence out while the queue is paused', async () => {
    setup();
    respond(1);
    const release = await startHeldTurn();
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue' });
    queue.pause();
    release();
    await loop.settled();

    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    lease?.dispose();
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);
  });

  it('hands a steer to the running turn immediately', async () => {
    setup();
    respond(2);
    const release = await startHeldTurn();

    const steered = await queue.submitInput({ id: 'p2', entry: entry('p2', 'steer now'), delivery: 'steer' });

    expect(steered.acceptedAs).toBe('steer');
    expect(steered.handle?.state).toBe('steered');
    expect(queue.snapshot().items).toEqual([]);
    release();
    await loop.settled();
    expect(launched).toEqual(['first']);
  });

  it('keeps steers ahead of queued inputs while paused and hands them off on resume', async () => {
    setup();
    respond(3);
    const release = await startHeldTurn();
    queue.pause();

    await queue.submitInput({ id: 'p2', entry: entry('p2', 'queued'), delivery: 'queue' });
    const held = await queue.submitInput({ id: 'p3', entry: entry('p3', 'held steer'), delivery: 'steer' });

    expect(held.acceptedAs).toBe('steer');
    expect(ids(queue.snapshot())).toEqual(['p3:steer', 'p2:queue']);

    queue.resume();
    await vi.waitFor(() => expect(loop.promptHandle('p3')?.state).toBe('steered'));
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);

    release();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'queued']));
    await loop.settled();
  });

  it('converts a queued input to a steer and reorders queued inputs', async () => {
    setup();
    respond(1);
    const release = await startHeldTurn();
    queue.pause();
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'two'), delivery: 'queue' });
    await queue.submitInput({ id: 'p3', entry: entry('p3', 'three'), delivery: 'queue' });
    await queue.submitInput({ id: 'p4', entry: entry('p4', 'four'), delivery: 'queue' });

    queue.move('p4', 'p2');
    expect(ids(queue.snapshot())).toEqual(['p4:queue', 'p2:queue', 'p3:queue']);
    queue.move('p4');
    expect(ids(queue.snapshot())).toEqual(['p2:queue', 'p3:queue', 'p4:queue']);

    queue.steer('p3');
    expect(ids(queue.snapshot())).toEqual(['p3:steer', 'p2:queue', 'p4:queue']);
    queue.steer('p4');
    expect(ids(queue.snapshot())).toEqual(['p3:steer', 'p4:steer', 'p2:queue']);

    expect(() => queue.move('p3')).toThrow(expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }));
    expect(() => queue.move('p2', 'p3')).toThrow(expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }));

    queue.cancel('p4');
    expect(ids(queue.snapshot())).toEqual(['p3:steer', 'p2:queue']);
    expect(() => queue.cancel('p4')).toThrow(expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }));
    expect(() => queue.steer('missing')).toThrow(expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }));
    release();
  });

  it('rejects duplicate ids', async () => {
    setup();
    respond(1);
    const release = await startHeldTurn();
    await queue.submitInput({ id: 'p3', entry: entry('p3', 'three'), delivery: 'queue' });
    await expect(
      queue.submitInput({ id: 'p3', entry: entry('p3', 'again'), delivery: 'queue' }),
    ).rejects.toMatchObject({ code: ErrorCodes.PROMPT_ID_CONFLICT });
    release();
  });

  it('applies the settings of a queued prompt only when it starts', async () => {
    setup();
    respond(2);
    const release = await startHeldTurn();
    const order: string[] = [];
    const prepare = vi.fn(async () => {
      order.push(`prepare:${launched.join(',')}`);
    });

    const queued = await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', prepare });

    expect(queued.acceptedAs).toBe('queue');
    expect(prepare).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
    expect(order).toEqual(['prepare:first']);
  });

  it('applies the settings of a queued prompt before steering it into the running turn', async () => {
    setup();
    respond(1);
    const release = await startHeldTurn();
    const prepare = vi.fn(async () => {});
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'steer me'), delivery: 'queue', prepare });

    queue.steer('p2');

    await vi.waitFor(() => expect(loop.promptHandle('p2')?.state).toBe('steered'));
    expect(prepare).toHaveBeenCalledOnce();
    expect(queue.snapshot().items).toEqual([]);
    release();
    await loop.settled();
  });

  it('pauses the queue with a warning when the settings of a queued prompt cannot be applied', async () => {
    setup();
    respond(2);
    const dispatch = vi.spyOn(ctx.dispatcher, 'dispatch');
    const release = await startHeldTurn();
    const prepare = vi.fn()
      .mockRejectedValueOnce(new Error('model is gone'))
      .mockResolvedValue(undefined);
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', prepare });

    release();
    await vi.waitFor(() => expect(queue.snapshot().paused).toBe(true));
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      code: 'queued-prompt-failed',
      message: expect.stringContaining('model is gone'),
    }));

    queue.resume();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('starts the next queued input only after the previous turn has been torn down', async () => {
    setup();
    respond(2);
    const release = await startHeldTurn();
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue' });
    const wire = ctx.get(IWireService);
    const drainPersisted = wire.drainPersisted.bind(wire);
    let finishDrain!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const drain = vi.spyOn(wire, 'drainPersisted').mockImplementation(async () => {
      await gate;
      await drainPersisted();
    });

    release();
    await vi.waitFor(() => expect(drain).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loop.canLaunchPrompt()).toBe(false);
    expect(launched).toEqual(['first']);

    finishDrain();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
  });

  it('keeps a queued prompt and pauses the queue with a warning when it cannot start', async () => {
    setup();
    respond(2);
    const dispatch = vi.spyOn(ctx.dispatcher, 'dispatch');
    const release = await startHeldTurn();
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue' });
    const submit = vi.spyOn(loop, 'submit').mockImplementationOnce(() => {
      throw new Error('session is stale');
    });

    release();
    await vi.waitFor(() => expect(queue.snapshot().paused).toBe(true));
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      code: 'queued-prompt-failed',
      message: expect.stringContaining('session is stale'),
    }));

    submit.mockRestore();
    queue.resume();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
  });

  it('holds a queued prompt at the head when the queue is paused while its settings are applied', async () => {
    setup();
    respond(2);
    const release = await startHeldTurn();
    let finishPrepare!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => {
      finishPrepare = resolve;
    }));
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', prepare });
    release();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);

    queue.pause();
    finishPrepare();
    await vi.waitFor(() => expect(queue.hasPendingItems()).toBe(false));
    expect(launched).toEqual(['first']);
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);

    queue.resume();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('withdraws a queued prompt that is cancelled while its settings are applied', async () => {
    setup();
    respond(1);
    const release = await startHeldTurn();
    let finishPrepare!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => {
      finishPrepare = resolve;
    }));
    const onDrop = vi.fn();
    const onStart = vi.fn(async () => {});
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', prepare, onStart, onDrop });
    release();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());

    queue.cancel('p2');
    finishPrepare();
    await vi.waitFor(() => expect(queue.hasPendingItems()).toBe(false));
    await loop.settled();
    expect(launched).toEqual(['first']);
    expect(onStart).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledOnce();
    expect(queue.snapshot().items).toEqual([]);
  });

  it('starts the new head first when another prompt moves ahead while settings are applied', async () => {
    setup();
    respond(3);
    const release = await startHeldTurn();
    let finishPrepare!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => {
      finishPrepare = resolve;
    }));
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', prepare });
    await queue.submitInput({ id: 'p3', entry: entry('p3', 'third'), delivery: 'queue' });
    release();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());

    queue.move('p3', 'p2');
    finishPrepare();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'third', 'second']));
    await loop.settled();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('announces an input held in the queue once to queued-prompt listeners', async () => {
    setup();
    respond(2);
    const dispatch = vi.spyOn(ctx.dispatcher, 'dispatch');
    const queuedEvents = () => dispatch.mock.calls
      .map(([event]) => event as { type: string; promptId?: string; queueLength?: number })
      .filter((event) => event.type === 'prompt.queued');
    const release = await startHeldTurn();
    expect(queuedEvents()).toEqual([]);

    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue' });
    expect(queuedEvents()).toEqual([expect.objectContaining({ promptId: 'p2', queueLength: 1 })]);

    release();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
    expect(queuedEvents()).toHaveLength(1);
  });

  it('fails an idle prompt whose start bookkeeping fails', async () => {
    setup();
    const onStart = vi.fn(async () => {
      throw new Error('metadata write failed');
    });

    await expect(
      queue.submitInput({ id: 'p1', entry: entry('p1', 'hello'), delivery: 'queue', onStart }),
    ).rejects.toThrow('metadata write failed');
    expect(launched).toEqual([]);
    expect(queue.snapshot().items).toEqual([]);
  });

  it('retries failed start bookkeeping once and does not repeat finished start steps', async () => {
    setup();
    respond(2);
    const dispatch = vi.spyOn(ctx.dispatcher, 'dispatch');
    const release = await startHeldTurn();
    const prepare = vi.fn(async () => {});
    const onStart = vi.fn(async () => {}).mockRejectedValueOnce(new Error('metadata write failed'));
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', prepare, onStart });

    release();
    await vi.waitFor(() => expect(queue.snapshot().paused).toBe(true));
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      code: 'queued-prompt-failed',
      message: expect.stringContaining('metadata write failed'),
    }));

    const submit = vi.spyOn(loop, 'submit').mockImplementationOnce(() => {
      throw new Error('session is stale');
    });
    queue.resume();
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(queue.snapshot().paused).toBe(true);
    submit.mockRestore();

    queue.resume();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
    expect(prepare).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it('checks that the session is current before applying the settings of an idle prompt', async () => {
    setup();
    const prepare = vi.fn(async () => {});
    vi.spyOn(ctx.get(ISessionRunGate), 'begin').mockImplementationOnce(() => {
      throw new Error('session is stale');
    });

    await expect(
      queue.submitInput({ id: 'p1', entry: entry('p1', 'hello'), delivery: 'queue', prepare }),
    ).rejects.toThrow('session is stale');
    expect(prepare).not.toHaveBeenCalled();
    expect(launched).toEqual([]);
  });

  it('queues an idle input at the head when other work starts while its settings are applied', async () => {
    setup();
    respond(2);
    let finishPrepare!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => {
      finishPrepare = resolve;
    }));
    const submitted = queue.submitInput({ id: 'p1', entry: entry('p1', 'first'), delivery: 'queue', prepare });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const hold = holdNextStep();
    loop.submit(entry('p2', 'direct'));
    await hold.started;
    finishPrepare();

    await expect(submitted).resolves.toMatchObject({ acceptedAs: 'queue' });
    expect(ids(queue.snapshot())).toEqual(['p1:queue']);
    hold.release();
    await vi.waitFor(() => expect(launched).toEqual(['direct', 'first']));
    await loop.settled();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('counts an idle input as pending while its settings are applied', async () => {
    setup();
    respond(1);
    let finishPrepare!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => {
      finishPrepare = resolve;
    }));
    const submitted = queue.submitInput({ id: 'p1', entry: entry('p1', 'first'), delivery: 'queue', prepare });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(queue.hasPendingItems()).toBe(true);
    expect(queue.hasPendingInputs()).toBe(true);
    finishPrepare();

    await expect(submitted).resolves.toMatchObject({ acceptedAs: 'turn' });
    expect(queue.hasPendingItems()).toBe(false);
    await loop.settled();
    expect(launched).toEqual(['first']);
  });

  it('reports a steer that falls back to the next turn as queued', async () => {
    setup();
    respond(2);
    const release = await startHeldTurn();
    vi.spyOn(loop, 'steer').mockRejectedValueOnce(new Error('the turn already ended'));

    const result = await queue.submitInput({ id: 'p2', entry: entry('p2', 'late steer'), delivery: 'steer' });

    expect(result.acceptedAs).toBe('queue');
    release();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'late steer']));
    await loop.settled();
  });

  it('runs start bookkeeping only when an input starts', async () => {
    setup();
    respond(2);
    const release = await startHeldTurn();
    const startedSecond = vi.fn(async () => {});
    const startedCancelled = vi.fn(async () => {});
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', onStart: startedSecond });
    await queue.submitInput({ id: 'p3', entry: entry('p3', 'third'), delivery: 'queue', onStart: startedCancelled });
    expect(startedSecond).not.toHaveBeenCalled();

    queue.cancel('p3');
    release();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
    expect(startedSecond).toHaveBeenCalledOnce();
    expect(startedCancelled).not.toHaveBeenCalled();
  });

  it('rejects every operation once the queue is disposed', async () => {
    setup();
    (queue as unknown as { dispose(): void }).dispose();
    const closed = expect.objectContaining({ code: ErrorCodes.SESSION_CLOSED });

    await expect(queue.submitInput({ id: 'p1', entry: entry('p1', 'late'), delivery: 'queue' }))
      .rejects.toMatchObject({ code: ErrorCodes.SESSION_CLOSED });
    expect(() => queue.submitCompaction({ id: 'c1' })).toThrow(closed);
    expect(() => queue.pause()).toThrow(closed);
    expect(() => queue.resume()).toThrow(closed);
    expect(() => queue.steer('p1')).toThrow(closed);
    expect(() => queue.move('p1')).toThrow(closed);
    expect(() => queue.cancel('p1')).toThrow(closed);
  });

  it('rejects an idle input whose queue is disposed while its settings are applied', async () => {
    setup();
    let finishPrepare!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => {
      finishPrepare = resolve;
    }));
    const submitted = queue.submitInput({ id: 'p1', entry: entry('p1', 'hello'), delivery: 'queue', prepare });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    (queue as unknown as { dispose(): void }).dispose();
    finishPrepare();

    await expect(submitted).rejects.toMatchObject({ code: ErrorCodes.SESSION_CLOSED });
    expect(launched).toEqual([]);
  });

  it('emits a snapshot for each change and skips no-op pause and resume', async () => {
    setup();
    respond(1);
    const release = await startHeldTurn();
    const events: PromptQueueSnapshot[] = [];
    queue.onDidChange((snapshot) => events.push(snapshot));

    queue.pause();
    queue.pause();
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'two'), delivery: 'queue' });
    queue.cancel('p2');
    queue.resume();
    queue.resume();

    expect(events.map((event) => [event.paused, event.items.length])).toEqual([
      [true, 0],
      [true, 1],
      [true, 0],
      [false, 0],
    ]);
    release();
    await loop.settled();
  });

  describe('compaction items', () => {
    function fakeCompaction(begin: (input: FullCompactionInput) => boolean): TestAgentServiceOverride {
      return agentService(IAgentFullCompactionService, {
        _serviceBrand: undefined,
        compacting: null,
        begin,
        cancel: () => {},
        hooks: { onWillCompact: { register: () => ({ dispose: () => {} }) } },
        onDidFinishCompaction: Event.None,
      } as unknown as IAgentFullCompactionService);
    }

    it('starts an idle compaction immediately', () => {
      const begin = vi.fn(() => true);
      setup(fakeCompaction(begin));

      expect(queue.submitCompaction({ id: 'c1', instruction: 'keep the plan' })).toEqual({ acceptedAs: 'compact' });
      expect(begin).toHaveBeenCalledWith({ source: 'manual', instruction: 'keep the plan' });
      expect(queue.snapshot().items).toEqual([]);
    });

    it('rejects an idle compaction when another one is running', () => {
      setup(fakeCompaction(() => false));

      expect(() => queue.submitCompaction({ id: 'c1' })).toThrow(
        expect.objectContaining({ code: ErrorCodes.COMPACTION_UNABLE }),
      );
    });

    it('rejects a compaction while another one is queued', async () => {
      setup(fakeCompaction(() => true));
      respond(1);
      const release = await startHeldTurn();

      queue.submitCompaction({ id: 'c1' });
      expect(() => queue.submitCompaction({ id: 'c2' })).toThrow(
        expect.objectContaining({ code: ErrorCodes.COMPACTION_UNABLE }),
      );
      expect(ids(queue.snapshot())).toEqual(['c1:queue']);
      release();
      await loop.settled();
    });

    it('queues a compaction behind a running turn and starts it once the agent is idle', async () => {
      const begin = vi.fn(() => true);
      setup(fakeCompaction(begin));
      respond(1);
      const release = await startHeldTurn();

      expect(queue.submitCompaction({ id: 'c1' })).toEqual({ acceptedAs: 'queue' });
      expect(queue.snapshot().items).toMatchObject([{ id: 'c1', kind: 'compact', delivery: 'queue' }]);
      expect(() => queue.steer('c1')).toThrow(expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }));
      expect(begin).not.toHaveBeenCalled();

      release();
      await vi.waitFor(() => expect(begin).toHaveBeenCalledWith({ source: 'manual', instruction: undefined }));
      expect(queue.snapshot().items).toEqual([]);
    });

    it('drops a queued compaction that cannot start with a warning and moves on to the next item', async () => {
      const begin = vi.fn(() => false);
      setup(fakeCompaction(begin));
      respond(2);
      const dispatch = vi.spyOn(ctx.dispatcher, 'dispatch');
      const release = await startHeldTurn();

      expect(queue.submitCompaction({ id: 'c1' })).toEqual({ acceptedAs: 'queue' });
      await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue' });
      release();

      await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
      expect(begin).toHaveBeenCalledOnce();
      expect(queue.snapshot().items).toEqual([]);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', code: 'queued-compaction-failed' }));
      await loop.settled();
    });

    it('counts a queued compaction as a pending item but not as a pending input', async () => {
      setup(fakeCompaction(() => true));
      respond(1);
      const release = await startHeldTurn();

      queue.submitCompaction({ id: 'c1' });
      expect(queue.hasPendingItems()).toBe(true);
      expect(queue.hasPendingInputs()).toBe(false);
      await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue' });
      expect(queue.hasPendingInputs()).toBe(true);
      queue.pause();
      expect(queue.hasPendingItems()).toBe(false);
      expect(queue.hasPendingInputs()).toBe(false);

      release();
      await loop.settled();
    });
  });
});
