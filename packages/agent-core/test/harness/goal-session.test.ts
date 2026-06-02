import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ProviderConfig } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderManager } from '../../src/session/provider-manager';
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

async function setupSession(sessionDir: string, events: Array<Record<string, unknown>>, tools: readonly string[]) {
  const scripted = createScriptedGenerate();
  const session = track(
    new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
    }),
  );
  const { agent } = await session.createAgent({ type: 'main', generate: scripted.generate }, goalProfile(tools));
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

    await api.createGoal({ objective: 'Ship feature X', completionCriterion: 'tests pass' });

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
    scripted.mockNextResponse({ type: 'text', text: 'The goal is complete.' });

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

    // After UpdateGoal runs, Anthropic-compatible providers require the next
    // request to end with a user message, not an assistant prefill.
    const afterUpdateGoalHistory = scripted.calls[2]?.history ?? [];
    const lastAfterUpdateGoal = afterUpdateGoalHistory.at(-1);
    expect(lastAfterUpdateGoal?.role).toBe('user');
    expect(JSON.stringify(lastAfterUpdateGoal?.content)).toContain('<system-reminder>');
    expect(JSON.stringify(lastAfterUpdateGoal?.content)).toContain('Goal complete.');

    // Completion is transient: it announces, then clears the durable record, so
    // the goal box disappears and nothing is left on disk.
    const raw = await readFile(join(sessionDir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { custom: { goal?: { status: string } } };
    expect(parsed.custom.goal).toBeUndefined();
    expect(api.getGoal({}).goal).toBeNull();

    // Audit trail records the whole run incl. completion — and no evaluator record.
    const wire = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const types = new Set(
      wire
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => (JSON.parse(l) as { type: string }).type),
    );
    for (const t of ['goal.create', 'goal.account_usage', 'goal.continuation', 'goal.update', 'goal.clear']) {
      expect(types.has(t)).toBe(true);
    }
    expect(types.has('goal.evaluate')).toBe(false);
  });

  it('blocks at a turn budget (no wrap-up segment)', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ objective: 'work', budgetLimits: { turnBudget: 1 } });

    scripted.mockNextResponse({ type: 'text', text: 'step 1' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();
    await session.flushMetadata();

    // One turn, then the turn budget blocks the goal (resumable) — no second turn.
    expect(api.getGoal({}).goal?.status).toBe('blocked');
    expect(scripted.calls.length).toBe(1);
  });

  it('preserves terminal status and demotes active goals across resume', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ objective: 'resume me' });
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
    expect(new SessionAPIImpl(resumed).getGoal({}).goal?.status).toBe('paused');
    await resumed.flushMetadata();
  });

  it('retains terminal blocked reason across resume', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session } = await setupSession(sessionDir, events, ['GetGoal']);
    await new SessionAPIImpl(session).createGoal({ objective: 'work' });
    await session.goals.markBlocked({
      actor: 'runtime',
      reason: 'needs credentials',
    });
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
    const goal = new SessionAPIImpl(resumed).getGoal({}).goal;
    expect(goal?.status).toBe('blocked');
    expect(goal?.terminalReason).toBe('needs credentials');
    await resumed.flushMetadata();
  });

  it('supports user lifecycle controls without a model turn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);

    await api.createGoal({ objective: 'work' });
    expect((await api.pauseGoal({})).status).toBe('paused');
    expect((await api.resumeGoal({})).status).toBe('active');
    // cancel discards the goal and returns its prior (active) snapshot.
    expect((await api.cancelGoal({})).status).toBe('active');
    expect(api.getGoal({}).goal).toBeNull();

    await api.createGoal({ objective: 'again' });
    await api.cancelGoal({});
    expect(api.getGoal({}).goal).toBeNull();
  });
});
