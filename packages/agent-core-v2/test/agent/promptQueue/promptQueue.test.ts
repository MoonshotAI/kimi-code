import { afterEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { IAgentFullCompactionService, type FullCompactionInput } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptQueueService, type PromptQueueSnapshot } from '#/agent/promptQueue/promptQueue';
import { ErrorCodes } from '#/errors';
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

  it('holds queued inputs while paused and lets an idle submit bypass them', async () => {
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
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);

    const direct = await queue.submitInput({ id: 'p3', entry: entry('p3', 'third'), delivery: 'queue' });
    expect(direct.acceptedAs).toBe('turn');
    await loop.settled();
    expect(launched).toEqual(['first', 'third']);
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);

    queue.resume();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'third', 'second']));
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

  it('rejects modes on steers and duplicate ids', async () => {
    setup();
    respond(1);
    const release = await startHeldTurn();
    queue.pause();

    await expect(
      queue.submitInput({ id: 'p2', entry: entry('p2', 'two'), delivery: 'steer', mode: 'plan' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    await queue.submitInput({ id: 'p3', entry: entry('p3', 'three'), delivery: 'queue', mode: 'swarm' });
    expect(() => queue.steer('p3')).toThrow(expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }));
    await expect(
      queue.submitInput({ id: 'p3', entry: entry('p3', 'again'), delivery: 'queue' }),
    ).rejects.toMatchObject({ code: ErrorCodes.PROMPT_ID_CONFLICT });
    expect(queue.snapshot().items).toMatchObject([{ id: 'p3', mode: 'swarm' }]);
    release();
  });

  it('applies a queued mode right before its turn starts', async () => {
    setup();
    respond(2);
    const release = await startHeldTurn();
    const order: string[] = [];
    const prepare = vi.fn(async () => {
      order.push(`prepare:${launched.length}`);
    });

    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', mode: 'plan', prepare });
    expect(prepare).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
    expect(prepare).toHaveBeenCalledOnce();
    expect(order).toEqual(['prepare:1']);
  });

  it('starts a queued input as a normal prompt and warns when its mode cannot be applied', async () => {
    setup();
    respond(2);
    const dispatch = vi.spyOn(ctx.dispatcher, 'dispatch');
    const release = await startHeldTurn();

    await queue.submitInput({
      id: 'p2',
      entry: entry('p2', 'second'),
      delivery: 'queue',
      mode: 'goal',
      prepare: () => Promise.reject(new Error('goal already exists')),
    });
    release();

    await vi.waitFor(() => expect(launched).toEqual(['first', 'second']));
    await loop.settled();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      code: 'queued-mode-failed',
      message: expect.stringContaining('goal already exists'),
    }));
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

  it('does not start a queued prompt that was cancelled while its mode was being applied', async () => {
    setup();
    respond(1);
    const release = await startHeldTurn();
    let finishPrepare!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => {
      finishPrepare = resolve;
    }));
    await queue.submitInput({ id: 'p2', entry: entry('p2', 'second'), delivery: 'queue', mode: 'plan', prepare });

    release();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(ids(queue.snapshot())).toEqual(['p2:queue']);
    queue.cancel('p2');
    finishPrepare();
    await loop.settled();
    await Promise.resolve();

    expect(launched).toEqual(['first']);
    expect(queue.snapshot().items).toEqual([]);
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

    it('drops a queued compaction that cannot start with a warning instead of silently', async () => {
      const begin = vi.fn(() => false);
      setup(fakeCompaction(begin));
      respond(1);
      const dispatch = vi.spyOn(ctx.dispatcher, 'dispatch');
      const release = await startHeldTurn();

      expect(queue.submitCompaction({ id: 'c1' })).toEqual({ acceptedAs: 'queue' });
      release();

      await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce());
      expect(queue.snapshot().items).toEqual([]);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', code: 'queued-compaction-failed' }));
    });
  });
});
