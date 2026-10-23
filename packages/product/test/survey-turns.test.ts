import { TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';
import { flattenChain } from '@moonshot-ai/agent-core-v2/wire/tree/index';
import { sliceMainRecordsAtTurn } from '@moonshot-ai/agent-core-v2/workspace/sessionLifecycle/internal/forkTurnSlice';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryWireRecordPersistence, testAgent, type TestAgentContext } from '../../agent-core-v2/test/harness';
import { isSurveyTurnOrigin, mountSurveyTurnCounter, SurveyTurnCounter } from '#/session-rating/node/index';

function barrier() {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function userPrompt(): TurnPrompt {
  return new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' } });
}

describe('survey history attachment', () => {
  it('does not count history twice when undo overlaps late attachment', async () => {
    const persistence = new InMemoryWireRecordPersistence([]);
    const ctx = testAgent({ persistence });
    const early = mountSurveyTurnCounter(ctx.dispatcher);
    await ctx.restorePersisted();
    await runUserTurn(ctx, 'one');
    await runUserTurn(ctx, 'two');
    const lateRead = barrier();
    const lateEntered = barrier();
    const restoreRead = barrier();
    const read = persistence.read.bind(persistence);
    let firstRead = true;
    persistence.read = async function* () {
      const late = firstRead;
      firstRead = false;
      if (!late && ctx.dispatcher.restorePhase === 'restoring') await restoreRead.promise;
      yield* read();
      if (late) {
        lateEntered.release();
        await lateRead.promise;
      }
    };
    const counter = mountSurveyTurnCounter(ctx.dispatcher);
    await lateEntered.promise;
    const undo = ctx.rpc.undoHistory({ count: 1 });
    try {
      await vi.waitFor(() => {
        expect(ctx.dispatcher.restorePhase).toBe('restoring');
      });
      lateRead.release();
      await counter.whenAttached;
      restoreRead.release();
      await undo;
      expect([early.count, counter.count]).toEqual([2, 2]);
      await runUserTurn(ctx, 'three');
      expect([early.count, counter.count]).toEqual([3, 3]);
    } finally {
      lateRead.release();
      restoreRead.release();
      await undo;
      early.dispose();
      counter.dispose();
    }
  });

  it('can join a restore already in progress', async () => {
    const ctx = testAgent({
      persistence: new InMemoryWireRecordPersistence([userPrompt().serialize(), userPrompt().serialize()]),
      autoConfigure: false,
    });
    const restoring = ctx.restorePersisted();
    const counter = mountSurveyTurnCounter(ctx.dispatcher);
    await restoring;
    await counter.whenAttached;
    expect(counter.count).toBe(2);
    await ctx.dispatcher.dispatch(userPrompt());
    expect(counter.count).toBe(3);
    counter.dispose();
  });

  it('can replace a pending counter without waiting for its old catch-up', async () => {
    const ctx = testAgent({
      persistence: new InMemoryWireRecordPersistence([userPrompt().serialize()]),
      autoConfigure: false,
    });
    await ctx.restorePersisted();
    const counter = mountSurveyTurnCounter(ctx.dispatcher);
    counter.dispose();
    const replacement = mountSurveyTurnCounter(ctx.dispatcher);
    const prompt = ctx.dispatcher.dispatch(userPrompt());
    await Promise.all([counter.whenAttached, replacement.whenAttached, prompt]);
    expect([counter.count, replacement.count]).toEqual([undefined, 2]);
    replacement.dispose();
  });

  it('releases a pending attachment when disposed and allows a fresh counter', async () => {
    const persistence = new InMemoryWireRecordPersistence([userPrompt().serialize()]);
    const ctx = testAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    persistence.flush = () => gate;
    const counter = mountSurveyTurnCounter(ctx.dispatcher);
    const pending = ctx.dispatcher.dispatch(userPrompt());
    counter.dispose();
    release();
    await counter.whenAttached;
    await pending;
    const replacement = mountSurveyTurnCounter(ctx.dispatcher);
    await replacement.whenAttached;
    expect([counter.count, replacement.count]).toEqual([undefined, 2]);
    replacement.dispose();
  });

  it('keeps queued prompts running when optional history catch-up fails', async () => {
    const persistence = new InMemoryWireRecordPersistence([userPrompt().serialize()]);
    const ctx = testAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();
    persistence.flush = () => Promise.reject(new Error('history unavailable'));
    const counter = mountSurveyTurnCounter(ctx.dispatcher);
    const prompt = ctx.dispatcher.dispatch(userPrompt());
    await expect(counter.whenAttached).rejects.toThrow('history unavailable');
    await expect(prompt).resolves.toBeUndefined();
    counter.dispose();
    persistence.flush = () => Promise.resolve();
    const replacement = mountSurveyTurnCounter(ctx.dispatcher);
    await replacement.whenAttached;
    expect(replacement.count).toBe(2);
    replacement.dispose();
  });

  it('does not invent a count when history IO fails and can retry with a new counter', async () => {
    const persistence = new InMemoryWireRecordPersistence([userPrompt().serialize()]);
    const ctx = testAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();
    persistence.flush = () => Promise.reject(new Error('history unavailable'));
    const failed = mountSurveyTurnCounter(ctx.dispatcher);
    await expect(failed.whenAttached).rejects.toThrow('history unavailable');
    failed.dispose();
    persistence.flush = () => Promise.resolve();
    const replacement = mountSurveyTurnCounter(ctx.dispatcher);
    await replacement.whenAttached;
    expect([failed.count, replacement.count]).toEqual([undefined, 1]);
    replacement.dispose();
  });

  it('catches up when attached after restore and includes live prompts exactly once', async () => {
    const ctx = testAgent({
      persistence: new InMemoryWireRecordPersistence([userPrompt().serialize(), userPrompt().serialize()]),
      autoConfigure: false,
    });
    await ctx.restorePersisted();
    const counter = mountSurveyTurnCounter(ctx.dispatcher);
    const pending = ctx.dispatcher.dispatch(userPrompt());
    expect(counter.count).toBeUndefined();
    await counter.whenAttached;
    await pending;
    expect(counter.count).toBe(3);
    counter.dispose();
  });

  it('counts restored history and subsequent prompts through the runtime interface', async () => {
    const ctx = testAgent({
      persistence: new InMemoryWireRecordPersistence([userPrompt().serialize(), userPrompt().serialize()]),
      autoConfigure: false,
    });
    const counter = mountSurveyTurnCounter(ctx.dispatcher);
    expect(counter.count).toBeUndefined();
    await ctx.restorePersisted();
    await counter.whenAttached;
    expect(counter.count).toBe(2);
    await ctx.dispatcher.dispatch(userPrompt());
    expect(counter.count).toBe(3);
    counter.dispose();
  });
});

describe('survey turn counting', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    [{ kind: 'user' }, undefined],
    [{ kind: 'skill_activation', trigger: 'user-slash' }, undefined],
    [{ kind: 'plugin_command', trigger: 'user-slash' }, undefined],
    [{ kind: 'injection' }, 1],
    [{ kind: 'shell_command', phase: 'input' }, 1],
    [{ kind: 'future_origin' }, 1],
  ])('keeps the historical message provenance policy for %j', (origin, expected) => {
    const counter = new SurveyTurnCounter();
    counter.observe({ type: 'context.append_message', message: { role: 'user', origin } }, 0);
    counter.observe({ type: 'turn.prompt', origin: { kind: 'user' } }, 1);

    expect(counter.count).toBe(expected);
  });

  it('distinguishes an empty history from an unclassifiable or corrupt history', () => {
    const empty = new SurveyTurnCounter();
    const unknown = new SurveyTurnCounter();
    unknown.observe({ type: 'turn.prompt', origin: { kind: 'user' } }, 0);
    unknown.observe({ type: 'turn.prompt', origin: { kind: 'future_origin' } }, 1);
    unknown.observe({ type: 'turn.prompt', origin: { kind: 'user' } }, 2);
    const corrupt = new SurveyTurnCounter();
    corrupt.observe({ type: 'turn.prompt', origin: { kind: 'user' } }, 0);
    corrupt.invalidate();
    expect([empty.count, unknown.count, corrupt.count]).toEqual([0, undefined, undefined]);
  });

  it('counts the same recorded actions in chronological and reverse scan order', () => {
    const records = [
      { type: 'turn.prompt', origin: { kind: 'user' } },
      { type: 'context.append_message', message: { role: 'user', origin: { kind: 'user' } } },
      { type: 'turn.prompt', origin: { kind: 'system_trigger' } },
      { type: 'turn.prompt', origin: { kind: 'skill_activation', trigger: 'user-slash' } },
      { type: 'turn.prompt', origin: { kind: 'shell_command', phase: 'input' } },
      { type: 'context.undo', count: 2 },
      { type: 'context.clear' },
      { type: 'context.apply_compaction', summary: 'summary' },
    ];
    const forward = new SurveyTurnCounter();
    const reverse = new SurveyTurnCounter();
    for (const [position, record] of records.entries()) forward.observe(record, position);
    for (const [position, record] of [...records.entries()].toReversed()) reverse.observe(record, position);

    expect([forward.count, reverse.count]).toEqual([3, 3]);
  });
});

describe('survey turn classification', () => {
  it('uses the rating policy for user actions, automatic work and unknown origins', () => {
    expect([
      { kind: 'user' },
      { kind: 'skill_activation', trigger: 'user-slash' },
      { kind: 'plugin_command', trigger: 'user-slash' },
      { kind: 'shell_command', phase: 'input' },
      { kind: 'shell_command', phase: 'result' },
      { kind: 'skill_activation', trigger: 'model' },
      { kind: 'plugin_command', trigger: 'model' },
      { kind: 'cron_job' },
      { kind: 'task' },
      { kind: 'system_trigger' },
      { kind: 'injection' },
      { kind: 'retry' },
      { kind: 'future_origin' },
      { kind: 'skill_activation' },
      { kind: 'shell_command' },
      null,
    ].map(isSurveyTurnOrigin)).toEqual([
      true, true, true, true, false, false, false, false,
      false, false, false, false, undefined, undefined, undefined, undefined,
    ]);
  });
});

async function runUserTurn(ctx: TestAgentContext, text: string): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: `reply to ${text}` });
  await ctx.rpc.prompt({ input: [{ type: 'text', text }] });
  await ctx.untilTurnEnd();
}

async function restoredCount(records: readonly WireRecord[]): Promise<number | undefined> {
  const resumed = testAgent({
    persistence: new InMemoryWireRecordPersistence(records),
    autoConfigure: false,
  });
  const counter = mountSurveyTurnCounter(resumed.dispatcher);
  await resumed.restorePersisted();
  return counter.count;
}

async function freshAgent() {
  const ctx = testAgent({ persistence: new InMemoryWireRecordPersistence([]) });
  const counter = mountSurveyTurnCounter(ctx.dispatcher);
  await ctx.restorePersisted();
  return { ctx, counter };
}

describe('survey counts across journal transformations', () => {
  it('matches between the live agent and a restore from its journal', async () => {
    const { ctx, counter } = await freshAgent();
    await runUserTurn(ctx, 'one');
    await runUserTurn(ctx, 'two');

    expect(counter.count).toBe(2);
    await expect(restoredCount(await ctx.persistedWireRecords())).resolves.toBe(2);
  });

  it('does not drop undone turns', async () => {
    const { ctx, counter } = await freshAgent();
    await runUserTurn(ctx, 'one');
    await runUserTurn(ctx, 'two');
    await runUserTurn(ctx, 'three');
    await ctx.rpc.undoHistory({ count: 2 });

    expect(counter.count).toBe(3);
    await expect(restoredCount(await ctx.persistedWireRecords())).resolves.toBe(3);
  });

  it('keeps turns from before a context clear', async () => {
    const { ctx, counter } = await freshAgent();
    await runUserTurn(ctx, 'one');
    await ctx.rpc.clearContext({});
    await runUserTurn(ctx, 'two');

    expect(counter.count).toBe(2);
    await expect(restoredCount(await ctx.persistedWireRecords())).resolves.toBe(2);
  });

  it('keeps turns from before a compaction', async () => {
    const { ctx, counter } = await freshAgent();
    await runUserTurn(ctx, 'one');
    await runUserTurn(ctx, 'two');
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;
    await runUserTurn(ctx, 'three');

    expect(counter.count).toBe(3);
    await expect(restoredCount(await ctx.persistedWireRecords())).resolves.toBe(3);
  });

  it('counts only the turns a fork from a history point inherits', async () => {
    const { ctx, counter } = await freshAgent();
    await runUserTurn(ctx, 'one');
    await runUserTurn(ctx, 'two');
    await runUserTurn(ctx, 'three');
    const records = flattenChain(await ctx.persistedWireRecords());

    await expect(
      restoredCount(sliceMainRecordsAtTurn(records, 'source', 1).records),
    ).resolves.toBe(2);
    await expect(restoredCount(records)).resolves.toBe(3);
  });
});
