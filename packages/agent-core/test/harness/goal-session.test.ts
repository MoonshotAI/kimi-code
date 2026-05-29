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

// Drive the goal evaluator deterministically without a model call.
const { evalQueue } = vi.hoisted(() => ({
  evalQueue: [] as Array<{ ok: boolean; verdict?: string; reason?: string; error?: string; usage: unknown }>,
}));
const ZERO_USAGE = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

vi.mock('../../src/agent/goal/evaluator', () => ({
  GoalEvaluator: class {
    async evaluate() {
      return (
        evalQueue.shift() ?? { ok: true, verdict: 'continue', reason: 'default', usage: ZERO_USAGE }
      );
    }
  },
}));

const GOAL_FLAG = 'KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND';
const MOCK_PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'mock-model' } as const satisfies ProviderConfig;

const tempDirs: string[] = [];

beforeEach(() => {
  process.env[GOAL_FLAG] = 'true';
  evalQueue.length = 0;
});

afterEach(async () => {
  delete process.env[GOAL_FLAG];
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
  const session = new Session({
    id: 'goal-session',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc: createSessionRpc(events),
    skills: { explicitDirs: [join(sessionDir, 'missing')] },
    providerManager: testProviderManager(),
  });
  const { agent } = await session.createAgent({ type: 'main', generate: scripted.generate }, goalProfile(tools));
  agent.config.update({ modelAlias: 'mock-model', thinkingLevel: 'off' });
  agent.permission.setMode('yolo');
  return { session, agent, scripted };
}

function waitForTurnEnd(events: Array<Record<string, unknown>>): Promise<void> {
  return vi.waitFor(() => {
    expect(events.some((e) => e['type'] === 'turn.ended')).toBe(true);
  }, { timeout: 10000, interval: 10 });
}

describe('goal session end-to-end', () => {
  it('drives a goal through continuation and an evaluator-confirmed completion', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);

    await api.createGoal({ objective: 'Ship feature X', completionCriterion: 'tests pass' });

    // Evaluator: continue after step 1 and step 3, then confirm complete after the report step.
    evalQueue.push(
      { ok: true, verdict: 'continue', reason: 'starting', usage: ZERO_USAGE },
      { ok: true, verdict: 'continue', reason: 'inspecting', usage: ZERO_USAGE },
      { ok: true, verdict: 'complete', reason: 'verified', usage: ZERO_USAGE },
    );

    // Scripted main-agent flow.
    scripted.mockNextResponse({ type: 'text', text: 'planning the work' });
    scripted.mockNextResponse({ type: 'function', id: 'c1', name: 'GetGoal', arguments: '{}' });
    scripted.mockNextResponse({ type: 'text', text: 'inspected the goal' });
    scripted.mockNextResponse({
      type: 'function',
      id: 'c2',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete', reason: 'done' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'reported completion' });

    agent.turn.prompt([{ type: 'text', text: 'Ship feature X' }]);
    await waitForTurnEnd(events);
    await session.flushMetadata();

    // Goal injection reached the model.
    const firstHistory = JSON.stringify(scripted.calls[0]?.history ?? []);
    expect(firstHistory).toContain('<untrusted_objective>');

    // Terminal complete state persisted to state.json.
    const raw = await readFile(join(sessionDir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { custom: { goal?: { status: string } } };
    expect(parsed.custom.goal?.status).toBe('complete');
    expect(api.getGoal({}).goal?.status).toBe('complete');

    // Token accounting ran for the goal.
    expect(api.getGoal({}).goal?.tokensUsed).toBeGreaterThan(0);

    // Audit trail in the main agent wire.
    const wire = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const types = new Set(
      wire
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => (JSON.parse(l) as { type: string }).type),
    );
    for (const t of ['goal.create', 'goal.account_usage', 'goal.continuation', 'goal.report', 'goal.evaluate', 'goal.update']) {
      expect(types.has(t)).toBe(true);
    }
  });

  it('stops at a turn budget with a single wrap-up', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ objective: 'work', budgetLimits: { turnBudget: 1 } });

    scripted.mockNextResponse({ type: 'text', text: 'step 1' });
    scripted.mockNextResponse({ type: 'text', text: 'wrap up' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await waitForTurnEnd(events);
    await session.flushMetadata();

    expect(api.getGoal({}).goal?.status).toBe('budget_limited');
    expect(scripted.calls.length).toBe(2);
  });

  it('preserves terminal status and demotes active goals across resume', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ objective: 'resume me' });
    await session.flushMetadata();

    const resumed = new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
    });
    await resumed.resume();
    expect(new SessionAPIImpl(resumed).getGoal({}).goal?.status).toBe('paused');
    await resumed.flushMetadata();
  });

  it('supports user lifecycle controls without a model turn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);

    await api.createGoal({ objective: 'work' });
    expect((await api.pauseGoal({})).status).toBe('paused');
    expect((await api.resumeGoal({})).status).toBe('active');
    expect((await api.cancelGoal({})).status).toBe('cancelled');
    expect(api.getGoal({}).goal).toBeNull();

    await api.createGoal({ objective: 'again' });
    await api.clearGoal({});
    expect(api.getGoal({}).goal).toBeNull();
  });
});
