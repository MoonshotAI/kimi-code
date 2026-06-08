import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { APIStatusError, type ProviderConfig } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderManager } from '../../src/session/provider-manager';
import type { AgentOptions } from '../../src/agent';
import type { HookDef } from '../../src/session/hooks';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { testKaos } from '../fixtures/test-kaos';

const GOAL_FLAG = 'KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND';
const MOCK_PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'mock-model' } as const satisfies ProviderConfig;

const tempDirs: string[] = [];
const openSessions: Session[] = [];

function track(session: Session): Session {
  openSessions.push(session);
  return session;
}

beforeEach(() => {
  process.env[GOAL_FLAG] = 'true';
});

afterEach(async () => {
  delete process.env[GOAL_FLAG];
  // Close sessions first so their async metadata/wire writes settle before the
  // temp dirs are removed (otherwise rm races with a write -> ENOTEMPTY).
  await Promise.allSettled(openSessions.splice(0).map((s) => s.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-goal-session-'));
  tempDirs.push(dir);
  return dir;
}

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: { test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey } },
      models: { [MOCK_PROVIDER.model]: { provider: 'test', model: MOCK_PROVIDER.model, maxContextSize: 1_000_000 } },
    },
  });
}

function goalProfile(tools: readonly string[]): ResolvedAgentProfile {
  return { name: 'test', systemPrompt: () => '<system-prompt>', tools: [...tools] };
}

function createSessionRpc(events: Array<Record<string, unknown>>): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async (event) => {
      events.push(event);
    }),
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;
}

async function readWireRecords(sessionDir: string): Promise<Array<Record<string, unknown>>> {
  const wire = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
  return wire
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function setupSession(
  sessionDir: string,
  events: Array<Record<string, unknown>>,
  tools: readonly string[],
  generate?: NonNullable<AgentOptions['generate']>,
  hooks?: readonly HookDef[],
) {
  const scripted = createScriptedGenerate();
  const session = track(
    new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
      hooks,
    }),
  );
  const { agent } = await session.createAgent(
    { type: 'main', generate: generate ?? scripted.generate },
    { profile: goalProfile(tools) },
  );
  agent.config.update({ modelAlias: 'mock-model', thinkingLevel: 'off' });
  agent.permission.setMode('yolo');
  return { session, agent, scripted };
}

describe('goal session end-to-end', () => {
  it('drives a goal across sequential turns until the model marks it complete', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);

    await api.createGoal({ agentId: 'main', objective: 'Ship feature X' });

    // Turn 1 stops without deciding -> the driver runs a second turn. In turn 2
    // the model calls UpdateGoal('complete'), which clears the goal and ends the
    // drive. No evaluator: the model's own tool call is the decision.
    scripted.mockNextResponse({ type: 'text', text: 'Working on the objective.' });
    scripted.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });

    agent.turn.prompt([{ type: 'text', text: 'Ship feature X' }]);
    // Wait for the whole goal drive (many turns), not just the first turn.ended.
    await agent.turn.waitForCurrentTurn();
    await session.flushMetadata();

    // The goal ran as more than one turn (start/end per continuation).
    const turnStarts = events.filter((e) => e['type'] === 'turn.started').length;
    expect(turnStarts).toBeGreaterThanOrEqual(2);

    // Goal injection reached the model on the first turn.
    const firstHistory = JSON.stringify(scripted.calls[0]?.history ?? []);
    expect(firstHistory).toContain('<untrusted_objective>');

    // Continuation turns should nudge the model to decide obvious terminal cases
    // instead of spending another round over-interpreting the goal.
    const continuationHistory = JSON.stringify(scripted.calls[1]?.history ?? []);
    expect(continuationHistory).toContain('Keep the self-audit brief');
    expect(continuationHistory).toContain('do not run another goal turn');

    // Terminal UpdateGoal ends the turn immediately. A neutral context reminder
    // is appended after the tool result, so any later request ends with a user
    // message rather than an assistant prefill.
    expect(scripted.calls).toHaveLength(2);
    const lastContextMessage = agent.context.history.at(-1);
    expect(lastContextMessage?.role).toBe('user');
    expect(JSON.stringify(lastContextMessage?.content)).toContain('<system-reminder>');
    expect(JSON.stringify(lastContextMessage?.content)).toContain('marked complete and cleared');

    // Completion is transient: it announces, then clears the durable record, so
    // the goal box disappears and nothing is left on disk.
    const raw = await readFile(join(sessionDir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { custom: { goal?: { status: string } } };
    expect(parsed.custom.goal).toBeUndefined();
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();

    // Audit trail records the whole run incl. completion — and no evaluator record.
    const records = await readWireRecords(sessionDir);
    const types = new Set(records.map((record) => record['type']));
    for (const t of ['goal.create', 'goal.update', 'goal.clear']) {
      expect(types.has(t)).toBe(true);
    }
    expect(types.has('goal.evaluate')).toBe(false);
    expect(types.has('goal.account_usage')).toBe(false);
    expect(types.has('goal.continuation')).toBe(false);
    const usageRecords = records.filter(
      (record) => record['type'] === 'goal.update' && typeof record['tokensUsed'] === 'number',
    );
    expect(usageRecords).toHaveLength(2);
    const finalUsage = usageRecords.at(-1)?.['tokensUsed'];
    expect(typeof finalUsage).toBe('number');
    const completion = records.find(
      (record) => record['type'] === 'goal.update' && record['status'] === 'complete',
    );
    expect(completion).toBeDefined();
    expect(finalUsage).toBeGreaterThan(0);
  });

  it('blocks at a turn budget (no wrap-up segment)', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');

    scripted.mockNextResponse({ type: 'text', text: 'step 1' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();
    await session.flushMetadata();

    // One turn, then the turn budget blocks the goal (resumable) — no second turn.
    expect((await api.getGoal({ agentId: 'main' })).goal?.status).toBe('blocked');
    expect(scripted.calls.length).toBe(1);
  });

  it('continues goal mode after the model resumes a paused goal', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await api.pauseGoal({ agentId: 'main' });

    scripted.mockNextResponse({
      type: 'function',
      id: 'resume',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'active' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'Resumed the goal.' });
    scripted.mockNextResponse({
      type: 'function',
      id: 'complete',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });

    agent.turn.prompt([{ type: 'text', text: 'Keep working on the goal' }]);
    await agent.turn.waitForCurrentTurn();

    expect(scripted.calls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(scripted.calls[0]?.history ?? [])).toContain('currently paused');
    expect(JSON.stringify(scripted.calls[2]?.history ?? [])).toContain('Continue working toward the active goal');
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
  });

  it('pauses the goal on provider rate limits', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal'], async () => {
      throw new APIStatusError(429, 'Rate limited', 'req-429');
    });
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('paused');
    expect(goal?.terminalReason).toBe('Paused after provider rate limit');
  });

  it('blocks the goal when the initial prompt hook blocks the objective', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(
      sessionDir,
      events,
      ['GetGoal', 'UpdateGoal'],
      undefined,
      [
        {
          event: 'UserPromptSubmit',
          matcher: 'blocked objective',
          command: "echo 'blocked by policy' >&2; exit 2",
        },
      ],
    );
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'blocked objective' });

    agent.turn.prompt([{ type: 'text', text: 'blocked objective' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(scripted.calls).toHaveLength(0);
    expect(goal?.status).toBe('blocked');
    expect(goal?.terminalReason).toBe('Blocked by UserPromptSubmit hook');
  });

  it('blocks immediately when a resumed goal is already over budget', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');
    await agent.goal.incrementTurn();
    await agent.goal.markBlocked({ reason: 'A configured budget was reached' });
    await api.resumeGoal({ agentId: 'main' });

    scripted.mockNextResponse({ type: 'text', text: 'should not run' });
    agent.turn.prompt([{ type: 'text', text: 'continue' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(scripted.calls).toHaveLength(0);
    expect(goal?.status).toBe('blocked');
    expect(goal?.turnsUsed).toBe(1);
  });

  it('stops before another model step when a token budget is reached mid-turn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } }, 'model');

    scripted.mockNextResponse({
      type: 'function',
      id: 'g1',
      name: 'GetGoal',
      arguments: JSON.stringify({}),
    });
    scripted.mockNextResponse({ type: 'text', text: 'should not run' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(scripted.calls).toHaveLength(1);
    expect(goal?.status).toBe('blocked');
    expect(goal?.tokensUsed).toBeGreaterThan(1);
  });

  it('preserves terminal status and demotes active goals across resume', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'resume me' });
    await session.flushMetadata();

    const resumed = track(new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
    }));
    await resumed.resume();
    expect((await new SessionAPIImpl(resumed).getGoal({ agentId: 'main' })).goal?.status).toBe('paused');
    await resumed.flushMetadata();
  });

  it('retains terminal blocked reason across resume', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal']);
    await new SessionAPIImpl(session).createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.markBlocked({ reason: 'needs credentials' });
    await session.flushMetadata();

    const resumed = track(new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
    }));
    await resumed.resume();
    const goal = (await new SessionAPIImpl(resumed).getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('blocked');
    expect(goal?.terminalReason).toBe('needs credentials');
    await resumed.flushMetadata();
  });

  it('supports user lifecycle controls without a model turn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);

    await api.createGoal({ agentId: 'main', objective: 'work' });
    expect((await api.pauseGoal({ agentId: 'main' })).status).toBe('paused');
    expect((await api.resumeGoal({ agentId: 'main' })).status).toBe('active');
    // cancel discards the goal and returns its prior (active) snapshot.
    expect((await api.cancelGoal({ agentId: 'main' })).status).toBe('active');
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
    const cancelReminder = agent.context.history.at(-1);
    expect(cancelReminder?.origin).toMatchObject({
      kind: 'system_trigger',
      name: 'goal_cancelled',
    });
    expect(JSON.stringify(cancelReminder?.content)).toContain('Ignore earlier active-goal reminders');

    await api.createGoal({ agentId: 'main', objective: 'again' });
    await api.cancelGoal({ agentId: 'main' });
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
  });
});
