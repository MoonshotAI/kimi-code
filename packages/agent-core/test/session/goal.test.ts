import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes } from '../../src/errors';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import {
  DEFAULT_GOAL_TURN_BUDGET,
  SessionGoalStore,
  type SessionGoalState,
} from '../../src/session/goal';
import type { SDKSessionRPC } from '../../src/rpc';
import { testKaos } from '../fixtures/test-kaos';

/** A simple in-memory backing for the goal store. */
function makeStore() {
  let state: SessionGoalState | undefined;
  let writeCount = 0;
  const store = new SessionGoalStore({
    sessionId: 'test',
    readState: () => state,
    writeState: async (next) => {
      state = next;
      writeCount += 1;
    },
  });
  return {
    store,
    current: () => state,
    writeCount: () => writeCount,
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-goal-'));
  tempDirs.push(dir);
  return dir;
}

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;
}

describe('SessionGoalStore creation', () => {
  it('creates a goal and exposes it through getGoal', async () => {
    const { store, current } = makeStore();
    const snapshot = await store.createGoal({ objective: 'Ship feature X' });
    expect(snapshot.objective).toBe('Ship feature X');
    expect(snapshot.status).toBe('active');
    expect(current()?.objective).toBe('Ship feature X');
    expect(store.getGoal().goal?.goalId).toBe(snapshot.goalId);
  });

  it('fills a default turn budget when none is provided', async () => {
    const { store } = makeStore();
    const snapshot = await store.createGoal({ objective: 'Do work' });
    expect(snapshot.budget.turnBudget).toBe(DEFAULT_GOAL_TURN_BUDGET);
  });

  it('rejects empty objectives', async () => {
    const { store } = makeStore();
    await expect(store.createGoal({ objective: '   ' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
    });
  });

  it('rejects objectives longer than 4000 characters', async () => {
    const { store } = makeStore();
    await expect(store.createGoal({ objective: 'x'.repeat(4001) })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
    });
  });

  it('rejects a duplicate active goal without replace', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'first' });
    await expect(store.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
  });

  it('rejects a duplicate paused goal without replace', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'first' });
    await store.pauseGoal();
    await expect(store.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
  });

  it('replaces an active goal when replace is set', async () => {
    const { store } = makeStore();
    const first = await store.createGoal({ objective: 'first' });
    const second = await store.createGoal({ objective: 'second', replace: true });
    expect(second.goalId).not.toBe(first.goalId);
    expect(store.getGoal().goal?.objective).toBe('second');
  });

  it('replaces a terminal goal without replace flag', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'first' });
    await store.updateGoal({ status: 'complete', reason: 'done' });
    const second = await store.createGoal({ objective: 'second' });
    expect(second.objective).toBe('second');
    expect(second.status).toBe('active');
  });
});

describe('SessionGoalStore reads', () => {
  it('returns { goal: null } when no goal exists', () => {
    const { store } = makeStore();
    expect(store.getGoal()).toEqual({ goal: null });
  });

  it('getGoal returns terminal snapshots until explicit clear', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.updateGoal({ status: 'complete', reason: 'done' });
    expect(store.getGoal().goal?.status).toBe('complete');
    await store.clearGoal();
    expect(store.getGoal()).toEqual({ goal: null });
  });

  it('getActiveGoal returns null for paused and terminal goals', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    expect(store.getActiveGoal()?.status).toBe('active');
    await store.pauseGoal();
    expect(store.getActiveGoal()).toBeNull();
    await store.resumeGoal();
    await store.updateGoal({ status: 'blocked', reason: 'stuck' });
    expect(store.getActiveGoal()).toBeNull();
  });
});

describe('SessionGoalStore budgets', () => {
  it('returns remainingTokens: null when no token budget is set', async () => {
    const { store } = makeStore();
    const snapshot = await store.createGoal({ objective: 'work' });
    expect(snapshot.budget.tokenBudget).toBeNull();
    expect(snapshot.budget.remainingTokens).toBeNull();
  });

  it('returns numeric remainingTokens when a token budget is set', async () => {
    const { store } = makeStore();
    const snapshot = await store.createGoal({
      objective: 'work',
      budgetLimits: { tokenBudget: 1000 },
    });
    expect(snapshot.budget.remainingTokens).toBe(1000);
  });

  it('computes token, turn, and wall-clock budget flags independently', async () => {
    const { store } = makeStore();
    await store.createGoal({
      objective: 'work',
      budgetLimits: { tokenBudget: 100, turnBudget: 2, wallClockBudgetMs: 1000 },
    });
    await store.recordTokenUsage({ tokenDelta: 100, agentId: 'main', agentType: 'main', source: 'agent_step' });
    let snap = store.getGoal().goal!;
    expect(snap.budget.tokenBudgetReached).toBe(true);
    expect(snap.budget.turnBudgetReached).toBe(false);
    expect(snap.budget.wallClockBudgetReached).toBe(false);
    expect(snap.budget.overBudget).toBe(true);

    await store.incrementTurn();
    await store.incrementTurn();
    snap = store.getGoal().goal!;
    expect(snap.budget.turnBudgetReached).toBe(true);

    await store.recordWallClockUsage({ wallClockMs: 1000 });
    snap = store.getGoal().goal!;
    expect(snap.budget.wallClockBudgetReached).toBe(true);
  });
});

describe('SessionGoalStore accounting', () => {
  it('recordTokenUsage counts token deltas', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.recordTokenUsage({ tokenDelta: 30, agentId: 'main', agentType: 'main', source: 'agent_step' });
    await store.recordTokenUsage({ tokenDelta: 12, agentId: 'agent-0', agentType: 'sub', source: 'agent_step' });
    expect(store.getGoal().goal?.tokensUsed).toBe(42);
  });

  it('accumulates sub-second wall-clock values', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.recordWallClockUsage({ wallClockMs: 250 });
    await store.recordWallClockUsage({ wallClockMs: 250 });
    expect(store.getGoal().goal?.wallClockMs).toBe(500);
  });

  it('incrementTurn counts continuation cycles', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.incrementTurn();
    await store.incrementTurn();
    expect(store.getGoal().goal?.turnsUsed).toBe(2);
  });

  it('does not account usage for paused or terminal goals', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    await store.recordTokenUsage({ tokenDelta: 5, agentId: 'main', agentType: 'main', source: 'agent_step' });
    await store.incrementTurn();
    const snap = store.getGoal().goal!;
    expect(snap.tokensUsed).toBe(0);
    expect(snap.turnsUsed).toBe(0);
  });
});

describe('SessionGoalStore reports and verdicts', () => {
  it('recordModelReport stores requested terminal state without changing status', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.recordModelReport({ requestedStatus: 'complete', reason: 'finished' });
    expect(snap.status).toBe('active');
    expect(snap.lastModelReportStatus).toBe('complete');
    expect(snap.lastModelReportReason).toBe('finished');
  });

  it('recordEvaluatorVerdict tracks no-progress streaks', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.recordEvaluatorVerdict({ verdict: 'no_progress', reason: 'stuck' });
    await store.recordEvaluatorVerdict({ verdict: 'no_progress', reason: 'stuck' });
    expect(store.getGoal().goal?.consecutiveNoProgressTurns).toBe(2);
    await store.recordEvaluatorVerdict({ verdict: 'continue', reason: 'moving' });
    expect(store.getGoal().goal?.consecutiveNoProgressTurns).toBe(0);
  });
});

describe('SessionGoalStore lifecycle', () => {
  it('pauseGoal and resumeGoal update status', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    expect((await store.pauseGoal()).status).toBe('paused');
    expect((await store.resumeGoal()).status).toBe('active');
  });

  it('updateGoal({ status: complete }) stores reason and evidence', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.updateGoal({
      status: 'complete',
      reason: 'all tests pass',
      evidence: [{ summary: 'tests green' }],
    });
    expect(snap.status).toBe('complete');
    expect(snap.terminalReason).toBe('all tests pass');
    expect(snap.terminalEvidence).toEqual([{ summary: 'tests green' }]);
  });

  it('updateGoal({ status: blocked }) stores reason and evidence', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.updateGoal({ status: 'blocked', reason: 'need creds' });
    expect(snap.status).toBe('blocked');
    expect(snap.terminalReason).toBe('need creds');
  });

  it('updateGoal({ status: impossible }) stores reason', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.updateGoal({ status: 'impossible', reason: 'contradiction' });
    expect(snap.status).toBe('impossible');
  });

  it('updateGoal rejects runtime-owned and user-owned statuses', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    for (const status of ['active', 'paused', 'cancelled', 'budget_limited', 'interrupted', 'error'] as const) {
      await expect(store.updateGoal({ status })).rejects.toMatchObject({
        code: ErrorCodes.GOAL_STATUS_INVALID,
      });
    }
  });

  it('mark* methods store runtime terminal states', async () => {
    for (const [method, status] of [
      ['markBudgetLimited', 'budget_limited'],
      ['markInterrupted', 'interrupted'],
      ['markError', 'error'],
    ] as const) {
      const { store } = makeStore();
      await store.createGoal({ objective: 'work' });
      const snap = await store[method]({ reason: 'r' });
      expect(snap?.status).toBe(status);
    }
  });

  it('mark* methods do not overwrite non-active goals', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    const result = await store.markError({ reason: 'boom' });
    expect(result).toBeNull();
    expect(store.getGoal().goal?.status).toBe('paused');
  });

  it('cancelGoal clears the current goal', async () => {
    const { store, current } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.cancelGoal({ reason: 'changed mind' });
    expect(snap.status).toBe('cancelled');
    expect(current()).toBeUndefined();
    expect(store.getGoal()).toEqual({ goal: null });
  });

  it('cancelGoal throws when no goal exists', async () => {
    const { store } = makeStore();
    await expect(store.cancelGoal()).rejects.toMatchObject({ code: ErrorCodes.GOAL_NOT_FOUND });
  });

  it('clearGoal is idempotent', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.clearGoal();
    await expect(store.clearGoal()).resolves.toBeUndefined();
    expect(store.getGoal()).toEqual({ goal: null });
  });
});

describe('SessionGoalStore disk persistence', () => {
  it('creating a goal writes metadata.custom.goal to state.json', async () => {
    const sessionDir = await makeTempDir();
    const session = new Session({
      id: 'goal-disk',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
    });

    await session.goals.createGoal({ objective: 'persist me' });
    await session.flushMetadata();

    const raw = await readFile(join(sessionDir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { custom: { goal?: { objective: string; status: string } } };
    expect(parsed.custom.goal?.objective).toBe('persist me');
    expect(parsed.custom.goal?.status).toBe('active');
  });
});

describe('SessionAPIImpl.updateSessionMetadata goal reservation', () => {
  function makeSession(sessionDir: string): Session {
    return new Session({
      id: 'goal-rpc',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
    });
  }

  it('preserves an active custom.goal across a generic metadata update', async () => {
    const sessionDir = await makeTempDir();
    const session = makeSession(sessionDir);
    await session.goals.createGoal({ objective: 'keep me' });
    const api = new SessionAPIImpl(session);

    await api.updateSessionMetadata({ metadata: { custom: { theme: 'dark' } } } as never);

    expect(session.metadata.custom['goal']?.objective).toBe('keep me');
    expect(session.metadata.custom['theme']).toBe('dark');
  });

  it('rejects a patch that writes custom.goal directly', async () => {
    const sessionDir = await makeTempDir();
    const session = makeSession(sessionDir);
    const api = new SessionAPIImpl(session);

    await expect(
      api.updateSessionMetadata({ metadata: { custom: { goal: { objective: 'hax' } } } } as never),
    ).rejects.toMatchObject({ code: ErrorCodes.GOAL_METADATA_RESERVED });
  });
});
