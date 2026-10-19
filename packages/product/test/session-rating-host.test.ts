import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import {
  bootstrap,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  IAgentLifecycleService,
  IAppendLogStore,
  IConfigService,
  IEventBus,
  IEventDispatcher,
  ISessionManager,
  logSeed,
  resolveLoggingConfig,
  MAIN_AGENT_ID,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionRatingHost } from '#/session-rating/node/index';

let home: string;
let core: Scope;
let host: SessionRatingHost | undefined;
let now: number;
let records: Readonly<Record<string, unknown>>[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'rating-host-'));
  core = bootstrap({
    homeDir: home,
    osHomeDir: home,
    cwd: home,
    env: {},
    clientIdentity: { productName: 'test-host', version: '0.0.0-test', platform: 'test' },
  }, logSeed(resolveLoggingConfig({ homeDir: home, env: {} }))).app;
  await core.accessor.get(IConfigService).ready;
  now = 0;
  records = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(async () => {
  host?.dispose();
  host = undefined;
  for (const session of core.accessor.get(ISessionManager).list()) {
    await core.accessor.get(ISessionManager).close(session.id);
  }
  core.dispose();
  await drainSessionIndexMirror();
  await drainQueryStoreDisposals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function startHost(): SessionRatingHost {
  host = new SessionRatingHost(core, {
    telemetryDisabled: () => false,
    preview: true,
    log: (message, properties) => {
      if (message === 'session rating preview event') records.push(properties);
    },
  });
  return host;
}

async function mainAgent(session: ISessionScopeHandle): Promise<IAgentScopeHandle> {
  const agents = session.accessor.get(IAgentLifecycleService);
  if (agents.get(MAIN_AGENT_ID) === undefined) await agents.create({ agentId: MAIN_AGENT_ID });
  const agent = agents.handleOf(MAIN_AGENT_ID);
  if (agent === undefined) throw new Error('missing main agent');
  return agent;
}

async function completeTurn(agent: IAgentScopeHandle): Promise<void> {
  const origin = { kind: 'user' } as const;
  await agent.accessor.get(IEventDispatcher).dispatch(new TurnPrompt({ agentId: MAIN_AGENT_ID, input: [], origin }));
  const bus = agent.accessor.get(IEventBus);
  bus.publish(new TurnStarted({ agentId: MAIN_AGENT_ID, turnId: 1, origin }));
  bus.publish(new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 1, reason: 'completed' }));
  await setImmediate();
  now += 2000;
}

function show(rating: SessionRatingHost, sessionId: string): void {
  const offer = rating.evaluate(sessionId);
  if (offer === undefined) throw new Error('expected a rating offer');
  rating.report(sessionId, { type: 'shown', appearanceId: offer.appearanceId });
}

describe('session rating host history', () => {
  it('shares normal session restoration without an extra history read', async () => {
    const manager = core.accessor.get(ISessionManager);
    const session = await manager.create({ workDir: home });
    await completeTurn(await mainAgent(session));
    await manager.close(session.id);
    const read = vi.spyOn(core.accessor.get(IAppendLogStore), 'read');
    const historyReads = (): number => read.mock.calls.filter(
      ([scope, key]) => scope.endsWith('/agents/main') && key === 'wire.jsonl',
    ).length;
    await manager.resume(session.id);
    const baselineReads = historyReads();
    expect(baselineReads).toBeGreaterThan(0);
    await manager.close(session.id);
    read.mockClear();
    const rating = startHost();
    const resumed = await manager.resume(session.id);
    if (resumed === undefined) throw new Error('missing resumed session');
    await completeTurn(await mainAgent(resumed));
    show(rating, session.id);
    expect(records.map((record) => record['user_turn_count'])).toEqual([2]);
    expect(historyReads()).toBe(baselineReads);
  });

  it('counts live turns and restored history before the next offer', async () => {
    const rating = startHost();
    const manager = core.accessor.get(ISessionManager);
    const session = await manager.create({ workDir: home });
    const agent = await mainAgent(session);
    await completeTurn(agent);
    await completeTurn(agent);
    show(rating, session.id);
    await manager.close(session.id);
    const resumed = await manager.resume(session.id);
    if (resumed === undefined) throw new Error('missing resumed session');
    await completeTurn(await mainAgent(resumed));
    show(rating, session.id);
    expect(records.map((record) => record['user_turn_count'])).toEqual([2, 3]);
  });

  it('catches up a host mounted after the agent has already restored', async () => {
    const manager = core.accessor.get(ISessionManager);
    const session = await manager.create({ workDir: home });
    const agent = await mainAgent(session);
    await completeTurn(agent);
    await completeTurn(agent);
    const rating = startHost();
    await completeTurn(agent);
    show(rating, session.id);
    expect(records.map((record) => record['user_turn_count'])).toEqual([3]);
  });
});
