import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes } from '../../src/errors';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import {
  SessionGoalStore,
  type GoalAuditSink,
  type GoalChange,
  type GoalSnapshot,
  type SessionGoalState,
} from '../../src/session/goal';
import type { AgentRecord } from '../../src/agent/records';
import type { SDKSessionRPC } from '../../src/rpc';
import type { TelemetryClient } from '../../src/telemetry';
import { testKaos } from '../fixtures/test-kaos';
import { recordingTelemetry, type TelemetryRecord } from '../fixtures/telemetry';

/** An in-memory store backing plus a controllable lazy audit sink. */
function makeAuditStore(opts: { sinkReady?: boolean } = {}) {
  let state: SessionGoalState | undefined;
  const records: AgentRecord[] = [];
  const sink: GoalAuditSink = { logRecord: (r) => records.push(r) };
  let ready = opts.sinkReady ?? true;
  const store = new SessionGoalStore({
    sessionId: 'test',
    readState: () => state,
    writeState: async (next) => {
      state = next;
    },
    auditSink: () => (ready ? sink : undefined),
  });
  return {
    store,
    records,
    types: () => records.map((r) => r.type),
    current: () => state,
    setState: (next: SessionGoalState | undefined) => {
      state = next;
    },
    enableSink: () => {
      ready = true;
    },
  };
}

function activeState(overrides: Partial<SessionGoalState> = {}): SessionGoalState {
  return {
    goalId: 'g-1',
    objective: 'do work',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedBy: 'user',
    updatedBy: 'user',
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budgetLimits: { turnBudget: 20 },
    ...overrides,
  };
}

/** A simple in-memory backing for the goal store. */
function makeStore(opts: { now?: () => number; telemetry?: TelemetryClient } = {}) {
  let state: SessionGoalState | undefined;
  let writeCount = 0;
  const updates: (GoalSnapshot | null)[] = [];
  const changes: (GoalChange | undefined)[] = [];
  const store = new SessionGoalStore({
    sessionId: 'test',
    readState: () => state,
    writeState: async (next) => {
      state = next;
      writeCount += 1;
    },
    onGoalUpdated: (snapshot, change) => {
      updates.push(snapshot);
      changes.push(change);
    },
    telemetry: opts.telemetry,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return {
    store,
    current: () => state,
    writeCount: () => writeCount,
    updates: () => updates,
    changes: () => changes,
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

  it('sets no default work caps when none is provided', async () => {
    const { store } = makeStore();
    const snapshot = await store.createGoal({ objective: 'Do work' });
    // No default turn / token / time cap: an unbounded goal runs until the
    // model reports it terminal via UpdateGoal.
    expect(snapshot.budget.turnBudget).toBeNull();
    expect(snapshot.budget.tokenBudget).toBeNull();
    expect(snapshot.budget.wallClockBudgetMs).toBeNull();
    expect(snapshot.budget.overBudget).toBe(false);
  });

  it('tracks basic goal usage without sending goal text', async () => {
    const records: TelemetryRecord[] = [];
    const { store } = makeStore({ telemetry: recordingTelemetry(records) });

    await store.createGoal({
      objective: 'private objective',
      completionCriterion: 'private criterion',
      budgetLimits: { turnBudget: 3 },
      replace: true,
    });
    await store.setBudgetLimits({
      budgetLimits: { tokenBudget: 100 },
      actor: 'model',
    });
    await store.incrementTurn();
    await store.pauseGoal({ reason: 'private pause reason' });
    await store.resumeGoal();
    await store.markComplete({ actor: 'model', reason: 'private completion reason' });

    expect(records.map((record) => record.event)).toEqual([
      'goal_created',
      'goal_budget_set',
      'goal_continued',
      'goal_status_changed',
      'goal_status_changed',
      'goal_status_changed',
      'goal_cleared',
    ]);
    expect(records[0]?.properties).toMatchObject({
      actor: 'user',
      replace: true,
      has_completion_criterion: true,
      has_turn_budget: true,
    });
    expect(records[1]?.properties).toMatchObject({
      actor: 'model',
      has_token_budget: true,
    });
    expect(records[3]?.properties).toMatchObject({ status: 'paused', actor: 'user' });
    expect(records[5]?.properties).toMatchObject({
      status: 'complete',
      actor: 'model',
      turns_used: 1,
    });
    expect(records[6]?.properties).toEqual({ actor: 'model' });
    expect(JSON.stringify(records)).not.toContain('private objective');
    expect(JSON.stringify(records)).not.toContain('private criterion');
    expect(JSON.stringify(records)).not.toContain('private pause reason');
    expect(JSON.stringify(records)).not.toContain('private completion reason');
  });

  it('notifies onGoalUpdated on lifecycle changes but not on token accounting', async () => {
    const { store, updates } = makeStore();
    await store.createGoal({ objective: 'work' });
    expect(updates().at(-1)?.status).toBe('active');
    const afterCreate = updates().length;

    // Per-step token usage must NOT emit a UI update (chatty).
    await store.recordTokenUsage({
      tokenDelta: 100,
      agentId: 'main',
      agentType: 'main',
      source: 'agent_step',
    });
    expect(updates().length).toBe(afterCreate);

    // A turn increment emits (badge turn count refreshes per turn).
    await store.incrementTurn();
    expect(updates().length).toBe(afterCreate + 1);
    expect(updates().at(-1)?.turnsUsed).toBe(1);

    // Pause emits the paused snapshot; cancel (discard) emits null.
    await store.pauseGoal();
    expect(updates().at(-1)?.status).toBe('paused');
    await store.cancelGoal();
    expect(updates().at(-1)).toBeNull();
  });

  it('emits a typed change for lifecycle and completion transitions', async () => {
    const { store, changes } = makeStore();
    await store.createGoal({ objective: 'work' }); // snapshot-only (no change)
    expect(changes().at(-1)).toBeUndefined();

    await store.incrementTurn(); // snapshot-only refresh
    expect(changes().at(-1)).toBeUndefined();

    await store.pauseGoal();
    expect(changes().at(-1)).toMatchObject({ kind: 'lifecycle', status: 'paused' });
    await store.resumeGoal();
    expect(changes().at(-1)).toMatchObject({ kind: 'lifecycle', status: 'active' });

    // markComplete emits a `completion` change (with stats), then clears the
    // durable record (a final null update), so the goal box disappears.
    await store.markComplete({ reason: 'done', actor: 'model' });
    const completion = changes().find((c) => c?.kind === 'completion');
    expect(completion).toMatchObject({ kind: 'completion', status: 'complete', reason: 'done' });
    expect(completion?.stats).toMatchObject({ turnsUsed: 1 });
    expect(store.getGoal().goal).toBeNull();
  });

  it('emits a blocked lifecycle change (resumable, not a terminal card)', async () => {
    const { store, changes } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.markBlocked({ reason: 'stuck' });
    expect(changes().at(-1)).toMatchObject({ kind: 'lifecycle', status: 'blocked', reason: 'stuck' });
    // Blocked persists and is resumable.
    expect(store.getGoal().goal?.status).toBe('blocked');
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

  it('rejects a duplicate blocked goal without replace (blocked is resumable)', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'first' });
    await store.markBlocked({ reason: 'stuck' });
    await expect(store.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
  });

  it('creating after completion needs no replace (completion cleared the goal)', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'first' });
    await store.markComplete({ reason: 'done' });
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

  it('getGoal returns a blocked snapshot until resumed or cancelled', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.markBlocked({ reason: 'stuck' });
    expect(store.getGoal().goal?.status).toBe('blocked');
    await store.cancelGoal();
    expect(store.getGoal()).toEqual({ goal: null });
  });

  it('markComplete clears the goal (transient — box disappears)', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.markComplete({ reason: 'done' });
    expect(store.getGoal()).toEqual({ goal: null });
  });

  it('getActiveGoal returns null for paused and blocked goals', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    expect(store.getActiveGoal()?.status).toBe('active');
    await store.pauseGoal();
    expect(store.getActiveGoal()).toBeNull();
    await store.resumeGoal();
    await store.markBlocked({ reason: 'stuck' });
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
    let clock = 1_000;
    const { store } = makeStore({ now: () => clock });
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

    // Live wall-clock: advancing the clock past the budget trips the flag.
    clock += 1_000;
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

  it('tracks live wall-clock from when the goal became active', async () => {
    let clock = 10_000;
    const { store } = makeStore({ now: () => clock });
    await store.createGoal({ objective: 'work' });
    clock += 500;
    expect(store.getGoal().goal?.wallClockMs).toBe(500);
    // Folds the interval and stops counting once the goal leaves `active`.
    clock += 250;
    await store.pauseGoal();
    clock += 9_999; // paused time must not accrue
    expect(store.getGoal().goal?.wallClockMs).toBe(750);
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

describe('SessionGoalStore lifecycle', () => {
  it('pauseGoal and resumeGoal update status and reason', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    const paused = await store.pauseGoal({ reason: 'taking a break' });
    expect(paused.status).toBe('paused');
    expect(paused.terminalReason).toBe('taking a break');
    const resumed = await store.resumeGoal();
    expect(resumed.status).toBe('active');
    expect(resumed.terminalReason).toBeUndefined();
  });

  it('markComplete returns a complete snapshot with reason, then clears', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.markComplete({ reason: 'all tests pass' });
    expect(snap?.status).toBe('complete');
    expect(snap?.terminalReason).toBe('all tests pass');
    // Transient: the durable record is gone.
    expect(store.getGoal().goal).toBeNull();
  });

  it('markBlocked stores reason and persists (resumable)', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.markBlocked({ reason: 'need creds' });
    expect(snap?.status).toBe('blocked');
    expect(snap?.terminalReason).toBe('need creds');
    expect(store.getGoal().goal?.status).toBe('blocked');
    // Resumable back to active.
    expect((await store.resumeGoal()).status).toBe('active');
  });

  it('resumeGoal is a fresh attempt: clears the stop reason', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.markBlocked({ reason: 'need creds' });

    const resumed = await store.resumeGoal();
    expect(resumed.status).toBe('active');
    expect(resumed.terminalReason).toBeUndefined();
  });

  it('markComplete and markBlocked no-op for non-active goals', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    expect(await store.markBlocked({ reason: 'boom' })).toBeNull();
    expect(await store.markComplete({ reason: 'done' })).toBeNull();
    expect(store.getGoal().goal?.status).toBe('paused');
  });

  it('pauseOnInterrupt parks an active goal as paused (resumable, not terminal)', async () => {
    const { store, changes } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.pauseOnInterrupt({ reason: 'Paused after interruption' });
    expect(snap?.status).toBe('paused');
    expect(snap?.terminalReason).toBe('Paused after interruption');
    // Emits a lifecycle change so the transcript marker / footer badge update.
    expect(changes().at(-1)).toMatchObject({ kind: 'lifecycle', status: 'paused' });
    // The goal stays resumable rather than dead-ending in a terminal state.
    const resumed = await store.resumeGoal();
    expect(resumed.status).toBe('active');
  });

  it('pauseOnInterrupt no-ops for a non-active goal', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.markBlocked({ reason: 'boom' });
    const result = await store.pauseOnInterrupt({ reason: 'Paused after interruption' });
    expect(result).toBeNull();
    expect(store.getGoal().goal?.status).toBe('blocked');
  });

  it('cancelGoal discards the goal and returns what it removed (no cancelled status)', async () => {
    const { store, current } = makeStore();
    await store.createGoal({ objective: 'work' });
    const snap = await store.cancelGoal({ reason: 'changed mind' });
    // The returned snapshot is the goal that was discarded, in its prior status.
    expect(snap.status).toBe('active');
    expect(current()).toBeUndefined();
    expect(store.getGoal()).toEqual({ goal: null });
  });

  it('cancelGoal throws when no goal exists', async () => {
    const { store } = makeStore();
    await expect(store.cancelGoal()).rejects.toMatchObject({ code: ErrorCodes.GOAL_NOT_FOUND });
  });

  it('cancelGoal removes the goal so a second cancel throws', async () => {
    const { store } = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.cancelGoal();
    expect(store.getGoal()).toEqual({ goal: null });
    await expect(store.cancelGoal()).rejects.toMatchObject({ code: ErrorCodes.GOAL_NOT_FOUND });
  });
});

describe('SessionGoalStore audit records', () => {
  it('writes directly when the sink is already available', async () => {
    const { store, types } = makeAuditStore({ sinkReady: true });
    await store.createGoal({ objective: 'work' });
    expect(types()).toEqual(['goal.create']);
  });

  it('queues records and flushes them in order when the sink becomes available', async () => {
    const { store, types, enableSink } = makeAuditStore({ sinkReady: false });
    await store.createGoal({ objective: 'work' });
    await store.incrementTurn();
    expect(types()).toEqual([]); // queued, not yet flushed
    enableSink();
    store.flushPendingRecords();
    expect(types()).toEqual(['goal.create', 'goal.continuation']);
  });

  it('flushPendingRecords is idempotent', async () => {
    const { store, types, enableSink } = makeAuditStore({ sinkReady: false });
    await store.createGoal({ objective: 'work' });
    enableSink();
    store.flushPendingRecords();
    store.flushPendingRecords();
    expect(types()).toEqual(['goal.create']);
  });

  it('replacing a goal appends one goal.clear before the new goal.create', async () => {
    const { store, types } = makeAuditStore();
    await store.createGoal({ objective: 'first' });
    await store.createGoal({ objective: 'second', replace: true });
    expect(types()).toEqual(['goal.create', 'goal.clear', 'goal.create']);
  });

  it('pauseGoal and resumeGoal append goal.update', async () => {
    const { store, types } = makeAuditStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    await store.resumeGoal();
    expect(types()).toEqual(['goal.create', 'goal.update', 'goal.update']);
  });

  it('markBlocked appends a goal.update with the blocked status', async () => {
    const { store, records } = makeAuditStore();
    await store.createGoal({ objective: 'work' });
    await store.markBlocked({ reason: 'stuck' });
    const last = records.at(-1);
    expect(last).toMatchObject({ type: 'goal.update', status: 'blocked' });
  });

  it('markComplete appends a goal.update (complete) then a goal.clear', async () => {
    const { store, types } = makeAuditStore();
    await store.createGoal({ objective: 'work' });
    await store.markComplete({ reason: 'done' });
    expect(types()).toEqual(['goal.create', 'goal.update', 'goal.clear']);
  });

  it('accounting appends goal.account_usage for token usage', async () => {
    const { store, records } = makeAuditStore();
    await store.createGoal({ objective: 'work' });
    await store.recordTokenUsage({ tokenDelta: 5, agentId: 'main', agentType: 'main', source: 'agent_step' });
    const usage = records.filter((r) => r.type === 'goal.account_usage');
    expect(usage.map((r) => (r as { usageKind: string }).usageKind)).toEqual(['token']);
  });

  it('incrementTurn appends goal.continuation', async () => {
    const { store, types } = makeAuditStore();
    await store.createGoal({ objective: 'work' });
    await store.incrementTurn();
    expect(types().at(-1)).toBe('goal.continuation');
  });

  it('cancelGoal appends only goal.clear (cancel = discard)', async () => {
    const { store, types } = makeAuditStore();
    await store.createGoal({ objective: 'work' });
    await store.cancelGoal({ reason: 'stop' });
    expect(types()).toEqual(['goal.create', 'goal.clear']);
  });
});

describe('SessionGoalStore normalizeMetadata', () => {
  it('converts an active goal to paused on resume', async () => {
    const { store, current, setState } = makeAuditStore();
    setState(activeState());
    await store.normalizeMetadata();
    expect(current()?.status).toBe('paused');
    expect(store.getGoal().goal?.status).toBe('paused');
  });

  it('queues a goal.update for the active-to-paused resume transition', async () => {
    const { store, types, setState } = makeAuditStore();
    setState(activeState());
    await store.normalizeMetadata();
    expect(types()).toEqual(['goal.update']);
  });

  it('keeps paused goals on resume', async () => {
    const { store, types, current, setState } = makeAuditStore();
    setState(activeState({ status: 'paused' }));
    await store.normalizeMetadata();
    expect(current()?.status).toBe('paused');
    expect(types()).toEqual([]);
  });

  it('keeps blocked goals on resume (resumable)', async () => {
    const { store, types, current, setState } = makeAuditStore();
    setState(activeState({ status: 'blocked', terminalReason: 'stuck' }));
    await store.normalizeMetadata();
    expect(current()?.status).toBe('blocked');
    expect(types()).toEqual([]);
  });

  it('removes malformed goal data on resume', async () => {
    const { store, current, setState } = makeAuditStore();
    setState({ bogus: true } as unknown as SessionGoalState);
    await store.normalizeMetadata();
    expect(current()).toBeUndefined();
  });

  it('removes a stray complete goal on resume (complete is transient)', async () => {
    const { store, current, setState } = makeAuditStore();
    setState(activeState({ status: 'complete', terminalReason: 'done' }));
    await store.normalizeMetadata();
    expect(current()).toBeUndefined();
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

  it('creates missing custom metadata before writing a goal', async () => {
    const sessionDir = await makeTempDir();
    const session = makeSession(sessionDir);
    (session.metadata as { custom?: Record<string, unknown> }).custom = undefined;

    await session.goals.createGoal({ objective: 'works on old metadata' });

    expect(session.metadata.custom['goal']?.objective).toBe('works on old metadata');
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

describe('SessionAPIImpl goal flag gating', () => {
  function makeSession(sessionDir: string, goalEnabled: boolean): Session {
    return new Session({
      id: 'goal-rpc-flag',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, {
        goal_command: goalEnabled,
      }),
    });
  }

  it('rejects SDK goal creation when the flag is disabled', async () => {
    const sessionDir = await makeTempDir();
    const session = makeSession(sessionDir, false);
    const api = new SessionAPIImpl(session);

    let thrown: unknown;
    try {
      void api.createGoal({ objective: 'work' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: ErrorCodes.NOT_IMPLEMENTED });
    expect(session.goals.getGoal().goal).toBeNull();
  });

  it('allows SDK goal creation when the flag is enabled', async () => {
    const sessionDir = await makeTempDir();
    const session = makeSession(sessionDir, true);
    const api = new SessionAPIImpl(session);

    const snapshot = await api.createGoal({ objective: 'work' });

    expect(snapshot.objective).toBe('work');
    expect(api.getGoal({}).goal?.status).toBe('active');
  });
});

describe('Session resume goal lifecycle', () => {
  function sessionOptions(sessionDir: string) {
    return {
      id: 'goal-resume',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
    } as const;
  }

  it('demotes an active goal to paused after resume', async () => {
    const sessionDir = await makeTempDir();
    const session = new Session(sessionOptions(sessionDir));
    await session.createMain();
    await session.goals.createGoal({ objective: 'resume me' });
    await session.flushMetadata();

    const resumed = new Session(sessionOptions(sessionDir));
    await resumed.resume();
    const goal = resumed.goals.getGoal().goal;
    expect(goal?.objective).toBe('resume me');
    expect(goal?.status).toBe('paused');
    await resumed.flushMetadata();
  });

  it('preserves a blocked goal after resume (resumable)', async () => {
    const sessionDir = await makeTempDir();
    const session = new Session(sessionOptions(sessionDir));
    await session.createMain();
    await session.goals.createGoal({ objective: 'finish me' });
    await session.goals.markBlocked({ reason: 'need input' });
    await session.flushMetadata();

    const resumed = new Session(sessionOptions(sessionDir));
    await resumed.resume();
    const goal = resumed.goals.getGoal().goal;
    expect(goal?.status).toBe('blocked');
    expect(goal?.terminalReason).toBe('need input');
    await resumed.flushMetadata();
  });
});
