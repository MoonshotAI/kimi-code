import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService, type AgentToolHook } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IFlagService } from '#/app/flag/flag';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionSubagentService } from '#/session/subagent/subagent';
import type { ISessionSwarmService } from '#/features/swarm/session/sessionSwarm';
import { IArtexModeService } from '#/features/artex/agent/artexMode';
import { ArtexEgressPacer, IArtexEgressPacer } from '#/features/artex/safety/egressPacer';
import { ArtexToolHooksService, IArtexToolHooksService } from '#/features/artex/safety/artexToolHooks';
import { ArtexSessionContext, IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { ArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { FileArtexGraphStore } from '#/features/artex/store/fileArtexGraphStore';
import type { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';
import { ArtexKillWorkTool } from '#/features/artex/tools/kill_work/kill_work';
import { ArtexSteerWorkTool } from '#/features/artex/tools/steer_work/steer_work';
import { newArtexBudget } from '#/features/artex/logic/budget';

import { ArtexCompactor } from './compactor';
import { ArtexOrchestrator, IArtexOrchestrator } from './artexOrchestrator';
import {
  buildFrontierSummary,
  emptyFrontierSummary,
  requiresIntentFloor,
  shouldRunPlanner,
} from './plannerStep';
import { artexSettleForOutcome, claimOpenFrontier, normalizeArtexTerminalReason } from './workerDispatch';
import { stubFlag } from '../../../../test/app/flag/stubs';
import { StubConfigService } from '../../../../test/stubs';

describe('planner hard-floor rule', () => {
  it('forces an intent when the goal is unmet and the frontier is empty', () => {
    expect(
      requiresIntentFloor({ ...emptyFrontierSummary(), goalMet: false }),
    ).toBe(true);
  });

  it('does not force an intent while open or running work exists', () => {
    expect(
      requiresIntentFloor({ ...emptyFrontierSummary(), goalMet: false, openIntents: 1 }),
    ).toBe(false);
    expect(
      requiresIntentFloor({ ...emptyFrontierSummary(), goalMet: false, runningIntents: 1 }),
    ).toBe(false);
  });

  it('never forces an intent once the goal is met', () => {
    expect(requiresIntentFloor(emptyFrontierSummary())).toBe(false);
    expect(
      requiresIntentFloor({ ...emptyFrontierSummary(), goalMet: true, openIntents: 0 }),
    ).toBe(false);
  });

  it('runs the planner when the goal is unmet and no open intents remain', () => {
    expect(shouldRunPlanner({ ...emptyFrontierSummary(), goalMet: false })).toBe(true);
    expect(
      shouldRunPlanner({ ...emptyFrontierSummary(), goalMet: false, runningIntents: 2 }),
    ).toBe(true);
  });

  it('skips the planner while an open frontier is available to claim', () => {
    expect(
      shouldRunPlanner({ ...emptyFrontierSummary(), goalMet: false, openIntents: 3 }),
    ).toBe(false);
    expect(shouldRunPlanner(emptyFrontierSummary())).toBe(false);
  });
});

describe('terminal routing', () => {
  it('maps swarm outcomes to intent settle states like ARTEX', () => {
    expect(artexSettleForOutcome({ status: 'completed' })).toBe('done');
    expect(artexSettleForOutcome({ status: 'completed', stopReason: 'max_turns' })).toBe('exhausted');
    expect(artexSettleForOutcome({ status: 'completed', stopReason: 'timeout' })).toBe('exhausted');
    expect(artexSettleForOutcome({ status: 'aborted' })).toBe('stopped');
    expect(artexSettleForOutcome({ status: 'failed' })).toBe('blocked');
  });

  it('normalizes free-form stop reasons into terminal reasons', () => {
    expect(normalizeArtexTerminalReason({ status: 'completed' })).toBe('completed');
    expect(normalizeArtexTerminalReason({ status: 'completed', stopReason: 'Reached max turns' })).toBe(
      'max_turns',
    );
    expect(normalizeArtexTerminalReason({ status: 'completed', stopReason: 'Timed out' })).toBe(
      'timeout',
    );
    expect(normalizeArtexTerminalReason({ status: 'failed' })).toBe('model_error');
  });
});

describe('claim fence under concurrency', () => {
  let dir: string;
  let store: FileArtexGraphStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-claim-'));
    store = new FileArtexGraphStore(dir, 1);
    await store.init('scope', 'find a vulnerability');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lets exactly one worker claim a single open intent across a concurrent dispatch burst', async () => {
    const intentId = await store.addIntent({ text: 'test one endpoint' }, 10);

    const burst = Array.from({ length: 64 }, (_, index) =>
      claimOpenFrontier(store, `worker-${String(index)}`, 1),
    );
    const results = await Promise.all(burst);

    const claimed = results.flat();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.intentId).toBe(intentId);

    const node = await store.getNode(intentId);
    expect(node?.state).toBe('running');
    expect(typeof node?.unclaimToken).toBe('string');
  });

  it('refuses a second claim on an already running intent', async () => {
    const intentId = await store.addIntent({ text: 'test one endpoint' }, 10);
    const first = await claimOpenFrontier(store, 'worker-a', 1);
    expect(first).toHaveLength(1);

    const second = await claimOpenFrontier(store, 'worker-b', 5);
    expect(second).toHaveLength(0);

    const summary = await buildFrontierSummary(store);
    expect(summary.openIntents).toBe(0);
    expect(summary.runningIntents).toBe(1);
  });

  it('shares a wide open frontier without double-claiming any intent', async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.addIntent({ text: `intent ${String(index)}` }, 5)),
    );

    const burst = Array.from({ length: 40 }, (_, index) =>
      claimOpenFrontier(store, `worker-${String(index)}`, ids.length + 5),
    );
    const claimed = (await Promise.all(burst)).flat();

    const claimedIds = claimed.map((claim) => claim.intentId);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(new Set(claimedIds)).toEqual(new Set(ids));
  });
});

describe('ArtexOrchestrator continuous sliding-window execution', () => {
  let dir: string;
  let storeProvider: ArtexGraphStoreProvider;
  let workProvider: ArtexWorkStoreProvider;
  let store: FileArtexGraphStore;
  let sessionCtx: ArtexSessionContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-orch-'));
    storeProvider = new ArtexGraphStoreProvider();
    workProvider = new ArtexWorkStoreProvider();
    store = new FileArtexGraphStore(dir, 1);
    await store.init('https://target.example.com', 'find and verify auth bypass');
    sessionCtx = new ArtexSessionContext({ sessionDir: dir } as unknown as ISessionContext);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeOrchestrator(handlers: {
    onPlanner: (prompt: string, signal: AbortSignal) => Promise<string>;
    onWorker: (intentId: number, prompt: string, signal: AbortSignal) => Promise<string>;
    onRemove?: (agentId: string) => void;
    eventBus?: EventBusService;
  }) {
    let seq = 0;
    const spawnedProfiles = new Map<string, { profile: string; intentId?: number; labels: Record<string, string> }>();
    const eventBus = handlers.eventBus ?? new EventBusService();

    const subagents: ISessionSubagentService = {
      _serviceBrand: undefined,
      hooks: { onWillStartAgentTask: { run: async () => {} } } as never,
      onDidStopAgentTask: (() => ({ dispose: () => {} })) as never,
      notifyAgentTaskStopped: () => {},
      planSpawn: async (input) => ({
        profileName: input.profileName ?? 'artex-worker',
        model: 'test-model',
        fork: false,
      }),
      spawn: async (opts) => {
        seq += 1;
        const agentId = `${opts.plan.profileName}-${String(seq)}`;
        const rawIntent = opts.labels?.['artexIntentId'];
        spawnedProfiles.set(agentId, {
          profile: opts.plan.profileName,
          intentId: rawIntent !== undefined ? Number(rawIntent) : undefined,
          labels: { ...opts.labels },
        });
        return {
          agentId,
          profileName: opts.plan.profileName,
          model: opts.plan.model,
          promptText: opts.prompt,
        };
      },
      run: async (agent, request, opts) => {
        const meta = spawnedProfiles.get(agent.agentId);
        const prompt = request.kind === 'prompt' ? request.prompt : '';
        const completion = (async () => {
          opts.signal.throwIfAborted();
          const summary =
            meta?.profile === 'artex-planner'
              ? await handlers.onPlanner(prompt, opts.signal)
              : await handlers.onWorker(meta?.intentId ?? 0, prompt, opts.signal);
          return { summary };
        })();
        return {
          agentId: agent.agentId,
          completion,
          partialOutput: () => '',
        };
      },
    };

    const lifecycle = {
      get: (agentId: string) => ({ agentId, generation: 0, space: undefined as never }),
      handleOf: (agentId: string) => {
        if (agentId === 'main') return undefined;
        return {
          id: agentId,
          accessor: {
            get: (id: unknown) => (id === IEventBus ? eventBus : undefined),
          },
        };
      },
      remove: async (ctx: { agentId: string }) => {
        handlers.onRemove?.(ctx.agentId);
      },
    } as unknown as IAgentLifecycleService;

    const recorder = {
      ensureStarted: async () => ({ status: 'off' }),
    } as unknown as IArtexTrafficRecorder;

    const orchestrator = new ArtexOrchestrator(
      storeProvider,
      {} as ISessionSwarmService,
      subagents,
      new StubConfigService({}),
      { sessionId: 'sess-1', sessionDir: dir } as ISessionContext,
      sessionCtx,
      recorder,
      lifecycle,
      workProvider,
    );
    return { orchestrator, eventBus };
  }

  it('seeds initial goal on init, runs planner Wave 0, dispatches worker, and settles on goal_met', async () => {
    const removed: string[] = [];
    let plannerRound = 0;
    const { orchestrator } = makeOrchestrator({
      onRemove: (id) => removed.push(id),
      onPlanner: async () => {
        plannerRound += 1;
        if (plannerRound === 1) {
          await store.addIntent({ summary: 'test /auth/login bypass' }, 9);
          return 'queued initial intent';
        }
        const goals = await store.listByKind('goal');
        for (const g of goals) await store.setNodeState(g.id, 'met');
        await store.markExplorationAchieved('goal proven');
        orchestrator.notifyGoalMet(1, 'goal proven');
        return 'goal met';
      },
      onWorker: async (intentId) => {
        await store.addNode({
          kind: 'fact',
          payload: { summary: `verified intent ${String(intentId)}`, confidence: 'observed', source: 'tool_output' },
          priority: 5,
          state: 'confirmed',
        });
        return '';
      },
    });

    const summary = await orchestrator.run({
      explorationId: 1,
      callerAgentId: 'main',
      plannerDebounceMs: 10,
      claimSweepIntervalMs: 5_000,
    });

    expect(summary.goalMet).toBe(true);
    expect(summary.stalled).toBe(false);
    expect(summary.dispatched).toBe(1);
    expect(summary.settled.done).toBe(1);
    expect(removed.length).toBeGreaterThanOrEqual(2);
    expect((await store.exploration()).status).toBe('achieved');
  });

  it('runs 120 concurrent slots and dispatches newly added intents without a lockstep wave barrier', async () => {
    const intentIds: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      intentIds.push(await store.addIntent({ summary: `probe surface ${String(i)}` }, 5));
    }
    const slowIntentId = intentIds[0]!;
    let slowFinished = false;
    let followUpIntentId: number | undefined;
    let followUpRanBeforeSlowFinished = false;
    let inFlight = 0;
    let peakInFlight = 0;

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const { orchestrator } = makeOrchestrator({
      onPlanner: async () => {
        if (slowFinished) {
          const goals = await store.listByKind('goal');
          for (const g of goals) await store.setNodeState(g.id, 'met');
          await store.markExplorationAchieved('all 120+ finished');
          orchestrator.notifyGoalMet(1, 'done');
        }
        return '';
      },
      onWorker: async (intentId) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          if (intentId === slowIntentId) {
            await slowGate;
            slowFinished = true;
            return 'slow done';
          }
          if (intentId === intentIds[1]) {
            followUpIntentId = await store.addIntent({ summary: 'follow-up while slow is running' }, 10);
            orchestrator.notifyGraphChanged(1, 'add_intent');
            return 'spawned follow-up';
          }
          if (intentId === followUpIntentId) {
            followUpRanBeforeSlowFinished = !slowFinished;
            releaseSlow();
            return 'follow-up done';
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          return 'fast done';
        } finally {
          inFlight -= 1;
        }
      },
    });

    const summary = await orchestrator.run({
      explorationId: 1,
      callerAgentId: 'main',
      targetConcurrency: 120,
      plannerDebounceMs: 10,
      claimSweepIntervalMs: 5_000,
    });

    expect(summary.goalMet).toBe(true);
    expect(summary.dispatched).toBe(121);
    expect(summary.settled.done).toBe(121);
    expect(peakInFlight).toBeGreaterThanOrEqual(50);
    expect(followUpRanBeforeSlowFinished).toBe(true);
  });

  it('aborts a live worker immediately on kill_work and recovers expired claims via claimSweepLoop', async () => {
    const liveIntentId = await store.addIntent({ summary: 'long running task' }, 10);
    let expiredIntentId = 0;
    let sawLiveAbort = false;
    let recoveredRan = false;

    const killTool = new ArtexKillWorkTool(sessionCtx, storeProvider);
    const { orchestrator } = makeOrchestrator({
      onPlanner: async () => {
        if (recoveredRan) {
          const goals = await store.listByKind('goal');
          for (const g of goals) await store.setNodeState(g.id, 'met');
          await store.markExplorationAchieved('recovered');
          orchestrator.notifyGoalMet(1, 'done');
        }
        return '';
      },
      onWorker: async (intentId, _prompt, signal) => {
        if (intentId === liveIntentId) {
          setTimeout(() => {
            void (async () => {
              const killToolWithOrch = new ArtexKillWorkTool(sessionCtx, storeProvider, orchestrator);
              const exec = killToolWithOrch.resolveExecution({
                intent_id: liveIntentId,
                reason: 'superseded',
              }) as unknown as { execute: (ctx: unknown) => Promise<unknown> };
              await exec.execute({});
            })();
          }, 15);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                sawLiveAbort = true;
                reject(signal.reason ?? new Error('aborted'));
              },
              { once: true },
            );
          });
        }
        if (intentId === expiredIntentId) {
          recoveredRan = true;
        }
        return 'ok';
      },
    });

    void killTool;

    expiredIntentId = await store.addIntent({ summary: 'stale claimed intent' }, 5);
    const expiredClaim = await store.claimIntentToken(expiredIntentId, 'dead-worker');
    expect(expiredClaim.claimed).toBe(true);
    const raw = await store.getNode(expiredIntentId);
    if (raw) {
      await store.mergeNodePayload(expiredIntentId, { stale_test: true });
    }
    const statePath = join(dir, '.artex', 'explorations', '1', 'state.json');
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as {
      nodes: Array<{ id: number; lastHeartbeatAt?: string }>;
    };
    const targetNode = parsed.nodes.find((n) => n.id === expiredIntentId);
    if (targetNode) targetNode.lastHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
    await writeFile(statePath, JSON.stringify(parsed, null, 2));

    const summary = await orchestrator.run({
      explorationId: 1,
      callerAgentId: 'main',
      plannerDebounceMs: 10,
      claimSweepIntervalMs: 25,
    });

    expect(sawLiveAbort).toBe(true);
    expect(recoveredRan).toBe(true);
    expect((await store.getNode(liveIntentId))?.state).toBe('stopped');
    expect((await store.getNode(expiredIntentId))?.state).toBe('done');
    expect(summary.goalMet).toBe(true);
  });

  it('delivers steer_work instructions into running workers via ArtexToolHooksService', async () => {
    const disposables = new DisposableStore();
    try {
      const ix = disposables.add(new TestInstantiationService());
      let hook!: AgentToolHook;
      ix.stub(IAgentToolExecutorService, {
        registerHook: (h: AgentToolHook) => {
          hook = h;
          return { dispose: () => {} };
        },
      } as unknown as IAgentToolExecutorService);
      ix.stub(IAgentProfileService, {
        data: () => ({ profileName: 'artex-worker' }),
      } as unknown as IAgentProfileService);
      ix.stub(IArtexModeService, { isActive: true } as unknown as IArtexModeService);
      ix.stub(IFlagService, stubFlag(true));
      ix.stub(IConfigService, new StubConfigService({}));
      ix.set(IArtexEgressPacer, new SyncDescriptor(ArtexEgressPacer));
      ix.stub(
        IAgentScopeContext,
        makeAgentScopeContext({
          agentId: 'worker-9',
          agentScope: '',
          meta: {
            homedir: dir,
            type: 'sub',
            labels: { artexIntentId: '10', artexExplorationId: '1' },
          },
        }),
      );
      ix.stub(IArtexSessionContext, sessionCtx);
      const remind = vi.fn();
      ix.stub(IAgentLoopService, { remind } as unknown as IAgentLoopService);
      const { orchestrator } = makeOrchestrator({
        onPlanner: async () => '',
        onWorker: async () => '',
      });
      ix.stub(IArtexOrchestrator, orchestrator);
      sessionCtx.setActiveExplorationId(1);
      const intentId = await store.addIntent({ summary: 'probe login' }, 5);
      await store.setIntentState(intentId, 'running');
      const steerTool = new ArtexSteerWorkTool(sessionCtx, storeProvider, orchestrator);
      const execSteer = steerTool.resolveExecution({
        intent_id: intentId,
        instruction: 'try X-Forwarded-For: 127.0.0.1',
      }) as unknown as { execute: (ctx: unknown) => Promise<{ isError?: boolean }> };

      ix.stub(
        IAgentScopeContext,
        makeAgentScopeContext({
          agentId: 'worker-9',
          agentScope: '',
          meta: {
            homedir: dir,
            type: 'sub',
            labels: { artexIntentId: String(intentId), artexExplorationId: '1' },
          },
        }),
      );
      ix.set(IArtexToolHooksService, new SyncDescriptor(ArtexToolHooksService));
      ix.get(IArtexToolHooksService);

      const steerResult = await execSteer.execute({});
      expect(steerResult.isError ?? false).toBe(false);
      await hook.beforeExecute?.({
        taskId: 't1',
        call: { id: 'c1', name: 'Read', arguments: '{}' },
        args: {},
        signal: new AbortController().signal,
      } as never);
      expect(remind).toHaveBeenCalledTimes(1);
      const after = await hook.afterExecute?.({
        taskId: 't1',
        call: { id: 'c1', name: 'Read', arguments: '{}' },
        result: { content: [{ type: 'text', text: 'file body' }] },
      } as never);
      expect(after?.content).toHaveLength(2);
      expect(JSON.stringify(after?.content)).toContain('X-Forwarded-For: 127.0.0.1');
    } finally {
      disposables.dispose();
    }
  });

  it('drives ColdGraph compaction and ArtexBudgetLedger wrap-up', async () => {
    const i1 = await store.addIntent({ summary: 'enum /a' }, 5);
    const i2 = await store.addIntent({ summary: 'enum /b' }, 5);
    const f1 = await store.addNode({
      kind: 'fact',
      payload: { summary: 'found /a 404', confidence: 'observed', source: 'tool_output' },
      priority: 5,
      state: 'confirmed',
    });
    const f2 = await store.addNode({
      kind: 'fact',
      payload: { summary: 'found /b 404', confidence: 'observed', source: 'tool_output' },
      priority: 5,
      state: 'confirmed',
    });
    await store.link(i1, 'yields', f1);
    await store.link(i2, 'yields', f2);
    await store.setIntentState(i1, 'done');
    await store.setIntentState(i2, 'done');

    const compactor = new ArtexCompactor({
      params: { r: 1, k: 2 },
      minorThreshold: 2,
      majorThreshold: 4,
      cooldownMs: 0,
    });
    await compactor.maintain(store);
    const compress = vi.fn(async (input: string) => `Compressed summary for: ${input.split('\n')[1] ?? ''}`);
    await compactor.onPlannerRound(store, compress, new AbortController().signal);
    await compactor.drain();

    const digests = await store.activeDigests();
    expect(digests.length).toBeGreaterThanOrEqual(1);
    expect(compress).toHaveBeenCalled();

    const ledger = newArtexBudget(100_000, 10);
    expect(ledger.tokens).toBe(100_000);
  });

  it('aborts a running worker when heartbeat fails (claim lost)', async () => {
    const intentId = await store.addIntent({ summary: 'heartbeat failure test' }, 10);
    let aborted = false;
    const origHeartbeat = FileArtexGraphStore.prototype.heartbeatIntentClaim;
    const heartbeatSpy = vi
      .spyOn(FileArtexGraphStore.prototype, 'heartbeatIntentClaim')
      .mockImplementation(async function (this: FileArtexGraphStore, id, token) {
        if (id === intentId) {
          throw new Error('claim lost');
        }
        return origHeartbeat.call(this, id, token);
      });

    const { orchestrator } = makeOrchestrator({
      onPlanner: async () => '',
      onWorker: async (id, _prompt, signal) => {
        if (id === intentId) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(signal.reason ?? new Error('aborted'));
              },
              { once: true },
            );
          });
        }
        return 'ok';
      },
    });

    try {
      const summary = await orchestrator.run({
        explorationId: 1,
        callerAgentId: 'main',
        plannerDebounceMs: 10,
        claimSweepIntervalMs: 5_000,
        heartbeatIntervalMs: 20,
      });

      expect(aborted).toBe(true);
      expect(summary.settled.stopped).toBeGreaterThanOrEqual(1);
    } finally {
      heartbeatSpy.mockRestore();
    }
  });
});
