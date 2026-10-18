import { produce } from 'immer';
import { describe, expect, it } from 'vitest';

import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { TurnPrompt } from '#/agent/loop/turnOps';
import {
  readSessionUserTurnCount,
  userTurnTallyKey,
  type UserTurnTally,
} from '#/agent/loop/userTurnTally';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { FoldContext } from '#/state/state';
import type { WireRecord } from '#/wire/record';
import { flattenChain } from '#/wire/tree/index';
import { sliceMainRecordsAtTurn } from '#/workspace/sessionLifecycle/internal/forkTurnSlice';

import { InMemoryWireRecordPersistence, testAgent, type TestAgentContext } from '../../harness';

const foldContext: FoldContext = {
  silent: false,
  checkpoint: () => {},
  clearCheckpoints: () => {},
  undoToCheckpoint: () => {},
  emit: () => {},
};

function fold(state: UserTurnTally, event: Event2): UserTurnTally {
  const entry = userTurnTallyKey.replayable.folds.get(event.constructor as Event2Class);
  if (entry === undefined) throw new Error(`tally fold not registered for '${event.type}'`);
  return produce(state, (draft) => entry(draft, event, foldContext) as void);
}

function prompt(origin: unknown): TurnPrompt {
  return new TurnPrompt({ agentId: 'main', input: [], origin: origin as PromptOrigin });
}

function userMessage(origin?: PromptOrigin): ContextAppendMessage {
  return new ContextAppendMessage({
    agentId: 'main',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [], origin },
  });
}

function countOf(state: UserTurnTally): number | undefined {
  return state.reliable ? state.count : undefined;
}

describe('userTurnTallyKey', () => {
  it('counts only prompts that the shared classification calls user turns', () => {
    let state = userTurnTallyKey.initial();
    state = fold(state, prompt({ kind: 'user' }));
    state = fold(state, userMessage({ kind: 'user' }));
    state = fold(state, prompt({ kind: 'skill_activation', trigger: 'user-slash' }));
    state = fold(state, prompt({ kind: 'shell_command', phase: 'input' }));
    state = fold(state, prompt({ kind: 'system_trigger' }));
    state = fold(state, prompt({ kind: 'task' }));
    state = fold(state, prompt({ kind: 'cron_job' }));

    expect(countOf(state)).toBe(3);
  });

  it('turns the count unknown once a prompt origin cannot be classified', () => {
    let state = userTurnTallyKey.initial();
    state = fold(state, prompt({ kind: 'user' }));
    state = fold(state, prompt({ kind: 'from_the_future' }));
    state = fold(state, prompt({ kind: 'user' }));

    expect(countOf(state)).toBeUndefined();
  });

  it('turns the count unknown when a user message precedes the first recorded prompt', () => {
    let state = userTurnTallyKey.initial();
    state = fold(state, userMessage());
    state = fold(state, prompt({ kind: 'user' }));

    expect(countOf(state)).toBeUndefined();
  });

  it('keeps the count known when only injected messages precede the first prompt', () => {
    let state = userTurnTallyKey.initial();
    state = fold(state, userMessage({ kind: 'injection', variant: 'agents_md' } as PromptOrigin));
    state = fold(state, prompt({ kind: 'user' }));

    expect(countOf(state)).toBe(1);
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
  await resumed.restorePersisted();
  return readSessionUserTurnCount(resumed.agentState);
}

async function freshAgent(): Promise<TestAgentContext> {
  const ctx = testAgent({ persistence: new InMemoryWireRecordPersistence([]) });
  await ctx.restorePersisted();
  return ctx;
}

function liveCount(ctx: TestAgentContext): number | undefined {
  return readSessionUserTurnCount(ctx.agentState);
}

describe('session user turn count', () => {
  it('matches between the live agent and a restore from its journal', async () => {
    const ctx = await freshAgent();
    await runUserTurn(ctx, 'one');
    await runUserTurn(ctx, 'two');

    expect(liveCount(ctx)).toBe(2);
    await expect(restoredCount(await ctx.persistedWireRecords())).resolves.toBe(2);
  });

  it('does not drop undone turns', async () => {
    const ctx = await freshAgent();
    await runUserTurn(ctx, 'one');
    await runUserTurn(ctx, 'two');
    await runUserTurn(ctx, 'three');
    await ctx.rpc.undoHistory({ count: 2 });

    expect(liveCount(ctx)).toBe(3);
    await expect(restoredCount(await ctx.persistedWireRecords())).resolves.toBe(3);
  });

  it('keeps turns from before a context clear', async () => {
    const ctx = await freshAgent();
    await runUserTurn(ctx, 'one');
    await ctx.rpc.clearContext({});
    await runUserTurn(ctx, 'two');

    expect(liveCount(ctx)).toBe(2);
    await expect(restoredCount(await ctx.persistedWireRecords())).resolves.toBe(2);
  });

  it('keeps turns from before a compaction', async () => {
    const ctx = await freshAgent();
    await runUserTurn(ctx, 'one');
    await runUserTurn(ctx, 'two');
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;
    await runUserTurn(ctx, 'three');

    expect(liveCount(ctx)).toBe(3);
    await expect(restoredCount(await ctx.persistedWireRecords())).resolves.toBe(3);
  });

  it('counts only the turns a fork from a history point inherits', async () => {
    const ctx = await freshAgent();
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
