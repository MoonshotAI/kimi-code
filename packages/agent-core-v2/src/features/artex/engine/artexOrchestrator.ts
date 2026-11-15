import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import {
  ISessionSwarmService,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from '#/features/swarm/session/sessionSwarm';

import {
  ARTEX_INTENT_CLAIM_HEARTBEAT_INTERVAL_MS,
  ARTEX_INTENT_CLAIM_TTL_MS,
  type ArtexIntentSettleState,
} from '#/features/artex/protocol/index';
import {
  IArtexGraphStoreProvider,
} from '#/features/artex/store/artexGraphStoreProvider';
import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import {
  resolveArtexPlannerDebounceMs,
  resolveArtexSwarmTimeoutMs,
  resolveArtexTargetConcurrency,
} from '#/features/artex/config/configSection';
import { ARTEX_PLANNER_PROFILE, ARTEX_WORKER_PROFILE } from '#/features/artex/profiles/artexProfiles';

import {
  buildFrontierSummary,
  buildPlannerBrief,
  requiresIntentFloor,
  shouldRunPlanner,
} from './plannerStep';
import {
  artexSettleForOutcome,
  buildWorkerBrief,
  claimOpenFrontier,
  normalizeArtexTerminalReason,
  type ArtexClaimedIntent,
} from './workerDispatch';

export interface ArtexOrchestratorOptions {
  readonly explorationId: number;
  readonly callerAgentId: string;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly maxWaves?: number;
  readonly workspaceRoot?: string;
}

export interface ArtexOrchestratorSummary {
  readonly waves: number;
  readonly dispatched: number;
  readonly settled: Record<ArtexIntentSettleState, number>;
  readonly goalMet: boolean;
  readonly stalled: boolean;
  readonly stopped: boolean;
}

export interface IArtexOrchestrator {
  readonly _serviceBrand: undefined;
  run(options: ArtexOrchestratorOptions): Promise<ArtexOrchestratorSummary>;
}

export const IArtexOrchestrator: ServiceIdentifier<IArtexOrchestrator> =
  createDecorator<IArtexOrchestrator>('artexOrchestrator');

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class ArtexOrchestrator extends Disposable implements IArtexOrchestrator {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IArtexGraphStoreProvider private readonly storeProvider: IArtexGraphStoreProvider,
    @ISessionSwarmService private readonly swarm: ISessionSwarmService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IConfigService private readonly config: IConfigService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IArtexSessionContext private readonly artexSession: IArtexSessionContext,
  ) {
    super();
  }

  async run(options: ArtexOrchestratorOptions): Promise<ArtexOrchestratorSummary> {
    const root = options.workspaceRoot ?? this.sessionContext.sessionDir;
    const store = this.storeProvider.open(root, options.explorationId);
    this.artexSession.setActiveExplorationId(options.explorationId);
    const owner = `artex-orchestrator:${this.sessionContext.sessionId}`;
    const targetConcurrency = resolveArtexTargetConcurrency(this.config);
    const timeoutMs = resolveArtexSwarmTimeoutMs(this.config);
    const debounceMs = resolveArtexPlannerDebounceMs(this.config);
    const settled: Record<ArtexIntentSettleState, number> = {
      done: 0,
      exhausted: 0,
      blocked: 0,
      stopped: 0,
      paused: 0,
    };
    let waves = 0;
    let dispatched = 0;
    let goalMet = false;
    let stalled = false;
    let stopped = false;

    for (;;) {
      if (options.signal?.aborted) {
        stopped = true;
        break;
      }
      if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) break;
      if (options.maxWaves !== undefined && waves >= options.maxWaves) break;

      await store.resetRunningIntents({ ttlMs: ARTEX_INTENT_CLAIM_TTL_MS });
      const summary = await buildFrontierSummary(store);
      if (summary.goalMet) {
        goalMet = true;
        break;
      }

      if (shouldRunPlanner(summary)) {
        await this.runPlanner(store, options.callerAgentId, timeoutMs, options.signal);
        if (options.signal?.aborted) {
          stopped = true;
          break;
        }
      }

      const claims = await claimOpenFrontier(store, owner, targetConcurrency);
      if (claims.length === 0) {
        const after = await buildFrontierSummary(store);
        if (requiresIntentFloor(after)) stalled = true;
        break;
      }

      const outcomes = await this.dispatchWave(
        store,
        options.callerAgentId,
        options.explorationId,
        claims,
        timeoutMs,
        waves,
        options.signal,
      );
      for (const state of outcomes) settled[state] += 1;
      dispatched += claims.length;
      waves += 1;

      await delay(debounceMs, options.signal);
    }

    return { waves, dispatched, settled, goalMet, stalled, stopped };
  }

  private async runPlanner(
    store: IArtexGraphStore,
    callerAgentId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const [root, stats, summary] = await Promise.all([
      store.root(),
      store.stats(),
      buildFrontierSummary(store),
    ]);
    const plan = await this.subagents.planSpawn({
      callerAgentId,
      profileName: ARTEX_PLANNER_PROFILE,
    });
    const task: SessionSwarmTask<undefined> = {
      kind: 'spawn',
      data: undefined,
      profileName: ARTEX_PLANNER_PROFILE,
      plan,
      parentToolCallId: 'artex-planner',
      prompt: buildPlannerBrief({ root, summary, stats }),
      description: 'artex planner round',
      runInBackground: false,
      timeout: timeoutMs,
      signal,
    };
    await this.swarm.run({ callerAgentId, tasks: [task] });
  }

  private async dispatchWave(
    store: IArtexGraphStore,
    callerAgentId: string,
    explorationId: number,
    claims: readonly ArtexClaimedIntent[],
    timeoutMs: number,
    wave: number,
    signal?: AbortSignal,
  ): Promise<ArtexIntentSettleState[]> {
    const root = await store.root();
    const plan = await this.subagents.planSpawn({
      callerAgentId,
      profileName: ARTEX_WORKER_PROFILE,
    });
    const tasks: SessionSwarmTask<ArtexClaimedIntent>[] = claims.map((claim, index) => ({
      kind: 'spawn',
      data: claim,
      profileName: ARTEX_WORKER_PROFILE,
      plan,
      parentToolCallId: `artex-wave-${String(explorationId)}-${String(wave)}`,
      prompt: buildWorkerBrief({ intent: claim.intent, root }),
      description: `artex worker intent #${String(claim.intentId)}`,
      swarmIndex: index + 1,
      runInBackground: false,
      timeout: timeoutMs,
      signal,
    }));

    const heartbeat = setInterval(() => {
      for (const claim of claims) {
        void store.heartbeatIntentClaim(claim.intentId, claim.token).catch(() => {});
      }
    }, ARTEX_INTENT_CLAIM_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    let results: readonly SessionSwarmRunResult<ArtexClaimedIntent>[];
    try {
      results = await this.swarm.run<ArtexClaimedIntent>({ callerAgentId, tasks });
    } finally {
      clearInterval(heartbeat);
    }

    const states: ArtexIntentSettleState[] = [];
    for (const result of results) {
      const claim = result.task.data;
      const state = artexSettleForOutcome({
        status: result.status,
        stopReason: result.stopReason,
      });
      await this.settle(store, claim, state, result);
      states.push(state);
    }
    return states;
  }

  private async settle(
    store: IArtexGraphStore,
    claim: ArtexClaimedIntent,
    state: ArtexIntentSettleState,
    result: SessionSwarmRunResult<ArtexClaimedIntent>,
  ): Promise<void> {
    await store
      .mergeNodePayload(claim.intentId, {
        worker_output: result.result ?? result.error ?? '',
        worker_agent_id: result.agentId,
        terminal_reason: normalizeArtexTerminalReason({
          status: result.status,
          stopReason: result.stopReason,
        }),
      })
      .catch(() => {});
    try {
      await store.settleIntentClaim(claim.intentId, claim.token, state);
    } catch {
      return;
    }
    await store
      .appendActivity({
        nodeId: claim.intentId,
        actor: 'orchestrator',
        kind: `settle:${state}`,
        detail: { agentId: result.agentId, stopReason: result.stopReason },
      })
      .catch(() => {});
  }
}
