import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { isUserCancellation, linkAbortSignal } from '#/_base/utils/abort';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { ErrorCodes, isError2 } from '#/errors';
import { isProviderRateLimitError } from '#/llm-adapter/contract/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { subagentLabels } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import {
  ISessionSwarmService,
  type SessionSwarmRunResult,
} from '#/features/swarm/session/sessionSwarm';

import {
  resolveArtexClaimSweepIntervalMs,
  resolveArtexNoiseProfile,
  resolveArtexPlannerDebounceMs,
  resolveArtexSwarmTimeoutMs,
  resolveArtexTargetConcurrency,
} from '#/features/artex/config/configSection';
import {
  ArtexBudgetLedger,
  artexBudgetWrapupBlocks,
  newArtexBudget,
  type ArtexBudget,
  type ArtexIntentMeter,
} from '#/features/artex/logic/budget';
import { clampMaxDuration, deadlineFromTimeout } from '#/features/artex/logic/taskClock';
import { ARTEX_PLANNER_PROFILE, ARTEX_WORKER_PROFILE } from '#/features/artex/profiles/artexProfiles';
import {
  ARTEX_INTENT_CLAIM_HEARTBEAT_INTERVAL_MS,
  ARTEX_INTENT_CLAIM_TTL_MS,
  ArtexIntentClaimLostError,
  type ArtexIntentSettleState,
  type ArtexTaskConstraint,
} from '#/features/artex/protocol/index';
import {
  ARTEX_UNTRUSTED_CONTENT_RULES,
  ARTEX_UNTRUSTED_DATA_RULES,
  renderArtexNoiseProfile,
  renderConstraintBlock,
} from '#/features/artex/prompts/index';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import type { ArtexExplorationRoot, IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

import { attachArtexActivityCapture } from './activityCapture';
import {
  ArtexCompactor,
  createLoopCompactorCompress,
  type ArtexCompactorCompressFn,
  type ArtexCompactorOptions,
} from './compactor';
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
  type ArtexSwarmStatus,
} from './workerDispatch';

export type ArtexWakeReason =
  | 'add_intent'
  | 'record_fact'
  | 'report_finding'
  | 'add_hint'
  | 'set_goals'
  | 'prove_goal'
  | 'goal_met'
  | 'steer_work'
  | 'kill_work'
  | 'worker_completed'
  | 'claim_sweep'
  | 'resume';

export interface ArtexOrchestratorOptions {
  readonly explorationId: number;
  readonly callerAgentId: string;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly timeoutSeconds?: number;
  readonly maxWaves?: number;
  readonly workspaceRoot?: string;
  readonly targetConcurrency?: number;
  readonly plannerDebounceMs?: number;
  readonly claimSweepIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly workerTimeoutMs?: number;
  readonly taskBudget?: ArtexBudget;
  readonly intentBudget?: ArtexBudget;
  readonly compactorOptions?: ArtexCompactorOptions;
  readonly compactorCompress?: ArtexCompactorCompressFn;
}

export interface ArtexOrchestratorSummary {
  readonly waves: number;
  readonly dispatched: number;
  readonly settled: Record<ArtexIntentSettleState, number>;
  readonly goalMet: boolean;
  readonly stalled: boolean;
  readonly stopped: boolean;
}

export interface ArtexOrchestratorStatus {
  readonly explorationId: number;
  readonly running: boolean;
  readonly paused: boolean;
  readonly activeWorkers: number;
  readonly waves: number;
  readonly dispatched: number;
  readonly settled: Record<ArtexIntentSettleState, number>;
  readonly goalMet: boolean;
  readonly stalled: boolean;
  readonly stopped: boolean;
}

export interface ArtexOrchestratorRunHandle {
  readonly explorationId: number;
  readonly completion: Promise<ArtexOrchestratorSummary>;
  stop(): void;
}

export interface IArtexOrchestrator {
  readonly _serviceBrand: undefined;
  run(options: ArtexOrchestratorOptions): Promise<ArtexOrchestratorSummary>;
  start(options: ArtexOrchestratorOptions): ArtexOrchestratorRunHandle;
  pause(explorationId: number): Promise<boolean>;
  stop(explorationId: number): boolean;
  getStatus(explorationId: number): ArtexOrchestratorStatus | undefined;
  notifyGraphChanged(explorationId: number, reason?: ArtexWakeReason): void;
  notifyGoalMet(explorationId: number, reason?: string): void;
  pauseIntent(intentId: number): boolean;
  abortIntent(intentId: number, reason?: unknown): boolean;
  enqueueSteer(intentId: number, instruction: string): void;
  drainSteers(intentId: number): readonly string[];
  isBudgetWrapup(explorationId: number): boolean;
  isToolBlockedByWrapup(explorationId: number, toolName: string): boolean;
}

export const IArtexOrchestrator: ServiceIdentifier<IArtexOrchestrator> =
  createDecorator<IArtexOrchestrator>('artexOrchestrator');

const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_RETRY_BASE_MS = 1_500;
const PAUSE_ABORT_REASON = Symbol('artex-pause');
const GOAL_MET_ABORT_REASON = Symbol('artex-goal-met');

interface ActiveRunEntry {
  readonly explorationId: number;
  readonly controller: AbortController;
  readonly completion: Promise<ArtexOrchestratorSummary>;
  paused: boolean;
  goalMetSignaled: boolean;
  pendingMutation: boolean;
  lastMutationAt: number;
  waves: number;
  dispatched: number;
  readonly settled: Record<ArtexIntentSettleState, number>;
  readonly activeWorkers: Map<number, Promise<void>>;
  goalMet: boolean;
  stalled: boolean;
  stopped: boolean;
  running: boolean;
  budgetLedger?: ArtexBudgetLedger;
  wake: () => void;
}

function waitUntil(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
  });
}

function runOutcomeFromError(error: unknown, signal: AbortSignal): {
  readonly status: ArtexSwarmStatus;
  readonly stopReason?: string;
  readonly errorText: string;
} {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason === GOAL_MET_ABORT_REASON) {
      return { status: 'completed', stopReason: 'completed', errorText: '' };
    }
    if (isUserCancellation(reason) || reason instanceof Error || typeof reason === 'string') {
      const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'aborted';
      return {
        status: 'aborted',
        stopReason: text,
        errorText: text,
      };
    }
    return { status: 'aborted', stopReason: 'aborted', errorText: 'aborted' };
  }
  if (isError2(error) && error.code === ErrorCodes.AGENT_NO_FINAL_MESSAGE) {
    return { status: 'completed', stopReason: 'completed', errorText: '' };
  }
  const message = error instanceof Error ? error.message : String(error);
  const low = message.toLowerCase();
  if (isError2(error) && error.code === ErrorCodes.LOOP_MAX_STEPS_EXCEEDED) {
    return { status: 'completed', stopReason: 'max_turns', errorText: message };
  }
  if (low.includes('timed out') || low.includes('timeout')) {
    return { status: 'completed', stopReason: 'timeout', errorText: message };
  }
  return { status: 'failed', stopReason: message, errorText: message };
}

export class ArtexOrchestrator extends Disposable implements IArtexOrchestrator {
  declare readonly _serviceBrand: undefined;

  private readonly runs = new Map<number, ActiveRunEntry>();
  private readonly activeIntentControllers = new Map<number, AbortController>();
  private readonly steerQueues = new Map<number, string[]>();

  constructor(
    @IArtexGraphStoreProvider private readonly storeProvider: IArtexGraphStoreProvider,
    @ISessionSwarmService _swarm: ISessionSwarmService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IConfigService private readonly config: IConfigService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IArtexSessionContext private readonly artexSession: IArtexSessionContext,
    @IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder,
    @IAgentLifecycleService private readonly agentLifecycle?: IAgentLifecycleService,
    @IArtexWorkStoreProvider private readonly workStoreProvider?: IArtexWorkStoreProvider,
  ) {
    super();
  }

  start(options: ArtexOrchestratorOptions): ArtexOrchestratorRunHandle {
    const existing = this.runs.get(options.explorationId);
    if (existing !== undefined && existing.running) {
      return {
        explorationId: options.explorationId,
        completion: existing.completion,
        stop: () => {
          this.stop(options.explorationId);
        },
      };
    }
    const controller = new AbortController();
    const unlink = options.signal === undefined ? () => {} : linkAbortSignal(options.signal, controller);
    const completion = this.run({ ...options, signal: controller.signal }).finally(() => {
      unlink();
    });
    void completion.catch(() => {});
    return {
      explorationId: options.explorationId,
      completion,
      stop: () => {
        controller.abort(new Error('stopped'));
      },
    };
  }

  async pause(explorationId: number): Promise<boolean> {
    const run = this.runs.get(explorationId);
    if (run === undefined || !run.running) return false;
    run.paused = true;
    run.controller.abort(PAUSE_ABORT_REASON);
    await run.completion.catch(() => undefined);
    return true;
  }

  stop(explorationId: number): boolean {
    const run = this.runs.get(explorationId);
    if (run === undefined || !run.running) return false;
    run.controller.abort(new Error('stopped'));
    return true;
  }

  getStatus(explorationId: number): ArtexOrchestratorStatus | undefined {
    const run = this.runs.get(explorationId);
    if (run === undefined) return undefined;
    return {
      explorationId: run.explorationId,
      running: run.running,
      paused: run.paused,
      activeWorkers: run.activeWorkers.size,
      waves: run.waves,
      dispatched: run.dispatched,
      settled: { ...run.settled },
      goalMet: run.goalMet,
      stalled: run.stalled,
      stopped: run.stopped,
    };
  }

  notifyGraphChanged(explorationId: number, _reason?: ArtexWakeReason): void {
    const run = this.runs.get(explorationId);
    if (run === undefined || !run.running) return;
    run.pendingMutation = true;
    run.lastMutationAt = Date.now();
    run.wake();
  }

  notifyGoalMet(explorationId: number, _reason?: string): void {
    const run = this.runs.get(explorationId);
    if (run === undefined || !run.running) return;
    run.goalMetSignaled = true;
    run.wake();
  }

  pauseIntent(intentId: number): boolean {
    const controller = this.activeIntentControllers.get(intentId);
    if (controller === undefined) return false;
    controller.abort(PAUSE_ABORT_REASON);
    return true;
  }

  abortIntent(intentId: number, reason?: unknown): boolean {
    const controller = this.activeIntentControllers.get(intentId);
    if (controller === undefined) return false;
    controller.abort(reason ?? new Error(`intent ${String(intentId)} killed`));
    return true;
  }

  enqueueSteer(intentId: number, instruction: string): void {
    const trimmed = instruction.trim();
    if (trimmed.length === 0) return;
    const queue = this.steerQueues.get(intentId) ?? [];
    queue.push(trimmed);
    this.steerQueues.set(intentId, queue);
  }

  drainSteers(intentId: number): readonly string[] {
    const queue = this.steerQueues.get(intentId);
    if (queue === undefined || queue.length === 0) return [];
    this.steerQueues.delete(intentId);
    return queue;
  }

  isBudgetWrapup(explorationId: number): boolean {
    return this.runs.get(explorationId)?.budgetLedger?.state().atMargin ?? false;
  }

  isToolBlockedByWrapup(explorationId: number, toolName: string): boolean {
    if (!this.isBudgetWrapup(explorationId)) return false;
    return artexBudgetWrapupBlocks(toolName);
  }

  async run(options: ArtexOrchestratorOptions): Promise<ArtexOrchestratorSummary> {
    const root = options.workspaceRoot ?? this.sessionContext.sessionDir;
    const store = this.storeProvider.open(root, options.explorationId);
    this.artexSession.setActiveExplorationId(options.explorationId);
    await this.recorder.ensureStarted();

    const owner = `artex-orchestrator:${this.sessionContext.sessionId}`;
    const targetConcurrency = options.targetConcurrency ?? resolveArtexTargetConcurrency(this.config);
    const swarmTimeoutMs = resolveArtexSwarmTimeoutMs(this.config);
    const debounceMs = options.plannerDebounceMs ?? resolveArtexPlannerDebounceMs(this.config);
    const claimSweepIntervalMs =
      options.claimSweepIntervalMs ?? resolveArtexClaimSweepIntervalMs(this.config);
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? ARTEX_INTENT_CLAIM_HEARTBEAT_INTERVAL_MS;

    const taskDeadlineUnixSec =
      options.deadlineMs !== undefined
        ? Math.floor(options.deadlineMs / 1000)
        : options.timeoutSeconds !== undefined && options.timeoutSeconds > 0
          ? deadlineFromTimeout(options.timeoutSeconds)
          : 0;

    const budgetLedger =
      options.taskBudget !== undefined || options.intentBudget !== undefined
        ? ArtexBudgetLedger.create(
            options.taskBudget ?? newArtexBudget(0, 0),
            options.intentBudget ?? newArtexBudget(0, 0),
          )
        : undefined;

    const compactor = new ArtexCompactor(options.compactorOptions);
    const compressFn =
      options.compactorCompress ??
      createLoopCompactorCompress(this.agentLifecycle?.handleOf(options.callerAgentId));

    const runController = new AbortController();
    const unlinkExternal =
      options.signal === undefined ? () => {} : linkAbortSignal(options.signal, runController);

    let wakeResolver: (() => void) | undefined;
    const entry: ActiveRunEntry = {
      explorationId: options.explorationId,
      controller: runController,
      completion: Promise.resolve({
        waves: 0,
        dispatched: 0,
        settled: { done: 0, exhausted: 0, blocked: 0, stopped: 0, paused: 0 },
        goalMet: false,
        stalled: false,
        stopped: false,
      }),
      paused: false,
      goalMetSignaled: false,
      pendingMutation: false,
      lastMutationAt: 0,
      waves: 0,
      dispatched: 0,
      settled: { done: 0, exhausted: 0, blocked: 0, stopped: 0, paused: 0 },
      activeWorkers: new Map(),
      goalMet: false,
      stalled: false,
      stopped: false,
      running: true,
      budgetLedger,
      wake: () => {
        wakeResolver?.();
        wakeResolver = undefined;
      },
    };

    const executeLoop = async (): Promise<ArtexOrchestratorSummary> => {
      const waitForWake = (timeoutMs?: number): Promise<void> => {
        if (runController.signal.aborted) return Promise.resolve();
        return new Promise<void>((resolve) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            if (wakeResolver === finish) wakeResolver = undefined;
            runController.signal.removeEventListener('abort', finish);
            resolve();
          };
          wakeResolver = finish;
          if (timeoutMs !== undefined && timeoutMs >= 0) {
            timer = setTimeout(() => finish(), timeoutMs);
            timer.unref?.();
          }
          runController.signal.addEventListener('abort', () => finish(), { once: true });
        });
      };

      const activeClaims = new Map<
        number,
        { readonly token: string; readonly controller: AbortController }
      >();
      let heartbeatInFlight = false;
      const heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight || activeClaims.size === 0) return;
        const batch = [...activeClaims.entries()].map(([id, item]) => ({
          id,
          token: item.token,
        }));
        heartbeatInFlight = true;
        void store
          .heartbeatIntentClaimsBatch(batch)
          .then((result) => {
            for (const lostId of result.lost) {
              const target = activeClaims.get(lostId);
              if (target !== undefined && !target.controller.signal.aborted) {
                target.controller.abort(new ArtexIntentClaimLostError(lostId, 'heartbeat'));
              }
            }
          })
          .catch((error) => {
            for (const item of batch) {
              const target = activeClaims.get(item.id);
              if (target !== undefined && !target.controller.signal.aborted) {
                target.controller.abort(error);
              }
            }
          })
          .finally(() => {
            heartbeatInFlight = false;
          });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();

      const sweepTimer = setInterval(() => {
        void store
          .resetRunningIntents({ ttlMs: ARTEX_INTENT_CLAIM_TTL_MS })
          .then((resetCount) => {
            if (resetCount > 0) this.notifyGraphChanged(options.explorationId, 'claim_sweep');
          })
          .catch(() => undefined);
      }, claimSweepIntervalMs);
      sweepTimer.unref?.();

      const deadlineTimer =
        taskDeadlineUnixSec > 0
          ? setTimeout(() => {
              entry.wake();
            }, Math.max(0, taskDeadlineUnixSec * 1000 - Date.now()))
          : undefined;
      deadlineTimer?.unref?.();

      let plannerPromise: Promise<void> | undefined;
      let plannerFailed = false;
      let consecutiveEmptyPlannerRounds = 0;

      const startPlannerRound = (): void => {
        if (plannerPromise !== undefined) return;
        const roundIndex = entry.waves;
        entry.waves += 1;
        plannerPromise = (async () => {
          const beforeOpen = await store.countOpenIntents();
          await compactor.onPlannerRound(store, compressFn, runController.signal);
          await this.runPlanner(
            store,
            root,
            options.callerAgentId,
            swarmTimeoutMs,
            taskDeadlineUnixSec,
            budgetLedger,
            roundIndex,
            runController.signal,
          );
          const afterOpen = await store.countOpenIntents();
          if (afterOpen <= beforeOpen) consecutiveEmptyPlannerRounds += 1;
          else consecutiveEmptyPlannerRounds = 0;
        })()
          .catch(() => {
            plannerFailed = true;
          })
          .finally(() => {
            plannerPromise = undefined;
            entry.wake();
          });
      };

      const launchWorker = (
        claim: ArtexClaimedIntent,
        prefetched: {
          readonly root: ArtexExplorationRoot;
          readonly constraints: readonly ArtexTaskConstraint[];
        },
      ): void => {
        const task = this.runSingleWorker(
          store,
          prefetched,
          options.callerAgentId,
          options.explorationId,
          claim,
          options.workerTimeoutMs ?? swarmTimeoutMs,
          activeClaims,
          taskDeadlineUnixSec,
          budgetLedger,
          runController.signal,
        )
          .then((settleState) => {
            entry.settled[settleState] += 1;
          })
          .catch(() => {
            entry.settled.blocked += 1;
          })
          .finally(() => {
            entry.activeWorkers.delete(claim.intentId);
            this.notifyGraphChanged(options.explorationId, 'worker_completed');
          });
        entry.activeWorkers.set(claim.intentId, task);
      };

      try {
        await store.resetRunningIntents({ ttlMs: ARTEX_INTENT_CLAIM_TTL_MS });

        for (;;) {
          if (runController.signal.aborted) {
            if (entry.paused) {
              for (const [intentId] of entry.activeWorkers) {
                this.abortIntent(intentId, PAUSE_ABORT_REASON);
              }
            } else {
              entry.stopped = true;
            }
            break;
          }

          if (taskDeadlineUnixSec > 0 && Date.now() >= taskDeadlineUnixSec * 1000) {
            for (const [intentId] of entry.activeWorkers) {
              this.abortIntent(intentId, new Error('exploration deadline reached'));
            }
            break;
          }

          const summary = await buildFrontierSummary(store);
          if (summary.goalMet || entry.goalMetSignaled) {
            entry.goalMet = true;
            for (const [intentId] of entry.activeWorkers) {
              this.abortIntent(intentId, GOAL_MET_ABORT_REASON);
            }
            break;
          }

          const budgetState = budgetLedger?.state();
          if (budgetState?.atMargin) {
            budgetLedger?.beginWrapup();
          }

          const allowDispatch =
            (budgetState === undefined || budgetState.dispatch) &&
            (options.maxWaves === undefined || entry.waves <= options.maxWaves);
          const freeSlots = allowDispatch ? Math.max(0, targetConcurrency - entry.activeWorkers.size) : 0;
          if (freeSlots > 0) {
            const claims = await claimOpenFrontier(store, owner, freeSlots);
            if (claims.length > 0) {
              const [batchRoot, batchConstraints] = await Promise.all([
                store.root(),
                this.loadConstraints(root, options.explorationId),
              ]);
              for (const claim of claims) {
                launchWorker(claim, { root: batchRoot, constraints: batchConstraints });
                entry.dispatched += 1;
              }
            }
          }

          const postClaimSummary = await buildFrontierSummary(store);
          if (postClaimSummary.goalMet || entry.goalMetSignaled) {
            entry.goalMet = true;
            break;
          }

          const canRunPlanner =
            plannerPromise === undefined &&
            !plannerFailed &&
            (options.maxWaves === undefined || entry.waves < options.maxWaves) &&
            (budgetState === undefined || !budgetState.atMargin);

          if (canRunPlanner) {
            const emptyFrontierUrgent =
              entry.activeWorkers.size === 0 &&
              postClaimSummary.openIntents === 0 &&
              shouldRunPlanner(postClaimSummary) &&
              consecutiveEmptyPlannerRounds === 0;
            const mutationReady =
              entry.pendingMutation && Date.now() - entry.lastMutationAt >= debounceMs;

            if (emptyFrontierUrgent || mutationReady) {
              entry.pendingMutation = false;
              startPlannerRound();
              if (entry.activeWorkers.size === 0 && plannerPromise !== undefined) {
                await plannerPromise;
                continue;
              }
            }
          }

          if (entry.activeWorkers.size === 0 && plannerPromise === undefined) {
            const finalSummary = await buildFrontierSummary(store);
            if (finalSummary.goalMet || entry.goalMetSignaled) {
              entry.goalMet = true;
              break;
            }
            if (finalSummary.openIntents > 0 && allowDispatch) {
              continue;
            }
            if (entry.pendingMutation && canRunPlanner) {
              const remainingDebounce = Math.max(0, debounceMs - (Date.now() - entry.lastMutationAt));
              await waitUntil(remainingDebounce, runController.signal);
              continue;
            }
            if (requiresIntentFloor(finalSummary)) {
              entry.stalled = true;
            }
            break;
          }

          let nextWakeMs: number | undefined;
          if (entry.pendingMutation && canRunPlanner) {
            nextWakeMs = Math.max(0, debounceMs - (Date.now() - entry.lastMutationAt));
          }
          await waitForWake(nextWakeMs);
        }
      } finally {
        clearInterval(heartbeatTimer);
        clearInterval(sweepTimer);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (entry.activeWorkers.size > 0) {
          await Promise.allSettled(entry.activeWorkers.values());
        }
        if (plannerPromise !== undefined) {
          await Promise.allSettled([plannerPromise]);
        }
        await compactor.drain();
        unlinkExternal();
        entry.running = false;
        if (this.runs.get(options.explorationId) === entry) {
          this.runs.delete(options.explorationId);
        }
      }

      return {
        waves: entry.waves,
        dispatched: entry.dispatched,
        settled: { ...entry.settled },
        goalMet: entry.goalMet,
        stalled: entry.stalled,
        stopped: entry.stopped,
      };
    };

    const completion = executeLoop();
    Object.assign(entry, { completion });
    this.runs.set(options.explorationId, entry);
    return completion;
  }

  private async loadConstraints(root: string, explorationId: number): Promise<readonly ArtexTaskConstraint[]> {
    if (this.workStoreProvider === undefined) return [];
    try {
      const workStore = this.workStoreProvider.open(root);
      await workStore.ensureSeeded();
      return await workStore.listConstraints(explorationId);
    } catch {
      return [];
    }
  }

  private async runPlanner(
    store: IArtexGraphStore,
    workspaceRoot: string,
    callerAgentId: string,
    timeoutMs: number,
    taskDeadlineUnixSec: number,
    budgetLedger: ArtexBudgetLedger | undefined,
    roundIndex: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const [root, stats, summary, constraints] = await Promise.all([
      store.root(),
      store.stats(),
      buildFrontierSummary(store),
      this.loadConstraints(workspaceRoot, store.explorationId),
    ]);
    const plan = await this.subagents.planSpawn({
      callerAgentId,
      profileName: ARTEX_PLANNER_PROFILE,
      allowFeatureProfiles: true,
    });
    const plannerController = new AbortController();
    const unlink = signal === undefined ? () => {} : linkAbortSignal(signal, plannerController);
    const effectiveTimeout = clampMaxDuration(taskDeadlineUnixSec, timeoutMs);
    const timeoutTimer =
      effectiveTimeout.effMs > 0
        ? setTimeout(() => {
            plannerController.abort(new Error('planner timed out'));
          }, effectiveTimeout.effMs)
        : undefined;
    timeoutTimer?.unref?.();

    const brief = buildPlannerBrief({
      root,
      summary,
      stats,
      constraints,
      budgetState: budgetLedger?.state(),
    });
    const systemTail = this.renderPlannerTail(root.goal, constraints);
    const prompt = systemTail.length > 0 ? `${systemTail}\n\n${brief}` : brief;

    const spawned = await this.subagents.spawn({
      callerAgentId,
      plan,
      labels: {
        ...subagentLabels(callerAgentId),
        artexExplorationId: String(store.explorationId),
        artexRole: 'planner',
      },
      prompt,
    });

    const requester = this.agentLifecycle?.handleOf(callerAgentId);
    const child = this.agentLifecycle?.handleOf(spawned.agentId);
    if (requester !== undefined) {
      emitAgentRunSpawned(requester, spawned.agentId, {
        profileName: plan.profileName,
        parentToolCallId: `artex-planner-${String(store.explorationId)}-${String(roundIndex)}`,
        description: `artex planner round ${String(roundIndex)}`,
        runInBackground: false,
        model: plan.model,
        modelSource: plan.modelSource,
      });
    }

    const childLoop = child?.accessor.get(IAgentLoopService);
    const childBus = child?.accessor.get(IEventBus);
    if (childLoop !== undefined && systemTail.length > 0) {
      const currentSys = childLoop.getSystemPrompt();
      if (currentSys.includes('{{.Goal}}')) {
        childLoop.update({ systemPrompt: currentSys.replaceAll('{{.Goal}}', root.goal) });
      }
    }

    const capture = attachArtexActivityCapture(
      childBus,
      spawned.agentId,
      store,
      undefined,
      'planner',
      (usage) => budgetLedger?.record(usage),
    );

    const agentContext =
      this.agentLifecycle?.get(spawned.agentId) ??
      ({ agentId: spawned.agentId, generation: 0, space: undefined as never } as const);

    try {
      const runHandle = await this.subagents.run(
        agentContext,
        { kind: 'prompt', prompt: spawned.promptText },
        { signal: plannerController.signal, allowEmptyFinalMessage: true },
      );
      const outcome =
        requester !== undefined
          ? await mirrorAgentRun(requester, runHandle, {
              profileName: plan.profileName,
              prompt: spawned.promptText,
              signal: plannerController.signal,
            })
          : await runHandle.completion;
      await capture.flushAndDispose({
        summary: outcome.summary || 'planner round completed',
        text: outcome.summary,
        detail: { agentId: spawned.agentId, stopReason: outcome.stopReason },
      });
    } catch (error) {
      await capture.flushAndDispose({
        isError: true,
        summary: error instanceof Error ? error.message : String(error),
        detail: { agentId: spawned.agentId },
      });
      if (!plannerController.signal.aborted) throw error;
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      unlink();
      await this.agentLifecycle?.remove(agentContext).catch(() => undefined);
    }
  }

  private async runSingleWorker(
    store: IArtexGraphStore,
    prefetched: {
      readonly root: ArtexExplorationRoot;
      readonly constraints: readonly ArtexTaskConstraint[];
    },
    callerAgentId: string,
    explorationId: number,
    claim: ArtexClaimedIntent,
    timeoutMs: number,
    activeClaims: Map<number, { readonly token: string; readonly controller: AbortController }>,
    taskDeadlineUnixSec: number,
    budgetLedger: ArtexBudgetLedger | undefined,
    parentSignal?: AbortSignal,
  ): Promise<ArtexIntentSettleState> {
    const workerController = new AbortController();
    const unlink = parentSignal === undefined ? () => {} : linkAbortSignal(parentSignal, workerController);
    this.activeIntentControllers.set(claim.intentId, workerController);
    activeClaims.set(claim.intentId, { token: claim.token, controller: workerController });

    const effectiveTimeout = clampMaxDuration(taskDeadlineUnixSec, timeoutMs);
    let timedOut = false;
    const timeoutTimer =
      effectiveTimeout.effMs > 0
        ? setTimeout(() => {
            timedOut = true;
            workerController.abort(new Error('worker timed out'));
          }, effectiveTimeout.effMs)
        : undefined;
    timeoutTimer?.unref?.();

    const meter: ArtexIntentMeter | undefined = budgetLedger?.startIntent();
    let agentId: string | undefined;
    let capture: ReturnType<typeof attachArtexActivityCapture> | undefined;
    let agentContext: ReturnType<IAgentLifecycleService['get']>;
    let outcomeStatus: ArtexSwarmStatus = 'completed';
    let stopReason: string | undefined;
    let finalText = '';
    let errorText: string | undefined;

    try {
      const { root, constraints } = prefetched;
      const plan = await this.subagents.planSpawn({
        callerAgentId,
        profileName: ARTEX_WORKER_PROFILE,
        allowFeatureProfiles: true,
      });
      const brief = buildWorkerBrief({ intent: claim.intent, root, constraints });
      const workerTail = this.renderWorkerTail();
      const prompt = workerTail.length > 0 ? `${workerTail}\n\n${brief}` : brief;

      const spawned = await this.subagents.spawn({
        callerAgentId,
        plan,
        labels: {
          ...subagentLabels(callerAgentId),
          artexIntentId: String(claim.intentId),
          artexExplorationId: String(explorationId),
          artexRole: 'worker',
        },
        prompt,
      });
      agentId = spawned.agentId;

      const requester = this.agentLifecycle?.handleOf(callerAgentId);
      const child = this.agentLifecycle?.handleOf(spawned.agentId);
      if (requester !== undefined) {
        emitAgentRunSpawned(requester, spawned.agentId, {
          profileName: plan.profileName,
          parentToolCallId: `artex-intent-${String(claim.intentId)}`,
          description: `artex worker intent #${String(claim.intentId)}`,
          runInBackground: false,
          model: plan.model,
          modelSource: plan.modelSource,
        });
      }

      const childBus = child?.accessor.get(IEventBus);
      capture = attachArtexActivityCapture(
        childBus,
        spawned.agentId,
        store,
        claim.intentId,
        spawned.agentId,
        (usage) => {
          meter?.record(usage);
          if (meter?.exhausted() && !workerController.signal.aborted) {
            stopReason = 'max_turns';
            workerController.abort(new Error('max_turns'));
          }
        },
      );

      agentContext =
        this.agentLifecycle?.get(spawned.agentId) ??
        ({ agentId: spawned.agentId, generation: 0, space: undefined as never } as const);

      let attempt = 0;
      let promptKind: 'prompt' | 'retry' = 'prompt';
      for (;;) {
        try {
          workerController.signal.throwIfAborted();
          const runHandle = await this.subagents.run(
            agentContext,
            promptKind === 'prompt'
              ? { kind: 'prompt', prompt: spawned.promptText }
              : { kind: 'retry' },
            { signal: workerController.signal, allowEmptyFinalMessage: true },
          );
          const completion =
            requester !== undefined && promptKind === 'prompt'
              ? await mirrorAgentRun(requester, runHandle, {
                  profileName: plan.profileName,
                  prompt: spawned.promptText,
                  suppressRateLimitFailureEvent: true,
                  signal: workerController.signal,
                })
              : await runHandle.completion;
          finalText = completion.summary;
          stopReason = completion.stopReason;
          outcomeStatus = 'completed';
          break;
        } catch (error) {
          if (
            isProviderRateLimitError(error) &&
            !workerController.signal.aborted &&
            attempt < RATE_LIMIT_MAX_RETRIES
          ) {
            attempt += 1;
            promptKind = 'retry';
            await waitUntil(RATE_LIMIT_RETRY_BASE_MS * 2 ** (attempt - 1), workerController.signal);
            continue;
          }
          if (timedOut) {
            outcomeStatus = 'completed';
            stopReason = 'timeout';
            errorText = 'worker timed out';
          } else {
            const classified = runOutcomeFromError(error, workerController.signal);
            outcomeStatus = classified.status;
            stopReason ??= classified.stopReason;
            errorText = classified.errorText;
          }
          break;
        }
      }
    } catch (error) {
      if (timedOut) {
        outcomeStatus = 'completed';
        stopReason = 'timeout';
        errorText = 'worker timed out';
      } else {
        const classified = runOutcomeFromError(error, workerController.signal);
        outcomeStatus = classified.status;
        stopReason ??= classified.stopReason;
        errorText = classified.errorText;
      }
    } finally {
      activeClaims.delete(claim.intentId);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      unlink();
      if (this.activeIntentControllers.get(claim.intentId) === workerController) {
        this.activeIntentControllers.delete(claim.intentId);
      }
      this.steerQueues.delete(claim.intentId);
      meter?.finish();
      await capture?.flushAndDispose({
        isError: outcomeStatus === 'failed',
        summary:
          (finalText.length > 0 ? finalText : errorText) ?? `settled:${outcomeStatus}`,
        text: finalText.length > 0 ? finalText : errorText,
        detail: { agentId, stopReason },
      });
      if (agentContext !== undefined) {
        await this.agentLifecycle?.remove(agentContext).catch(() => undefined);
      }
    }

    const paused = workerController.signal.aborted && workerController.signal.reason === PAUSE_ABORT_REASON;
    const settleState: ArtexIntentSettleState = paused
      ? 'paused'
      : artexSettleForOutcome({ status: outcomeStatus, stopReason });

    const synthResult: SessionSwarmRunResult<ArtexClaimedIntent> = {
      task: {
        kind: 'spawn',
        data: claim,
        profileName: ARTEX_WORKER_PROFILE,
        plan: { profileName: ARTEX_WORKER_PROFILE, model: '', fork: false },
        parentToolCallId: `artex-intent-${String(claim.intentId)}`,
        prompt: '',
        description: '',
        runInBackground: false,
      },
      agentId,
      status: outcomeStatus,
      result: finalText,
      error: errorText,
      stopReason,
    };
    await this.settle(store, claim, settleState, synthResult);
    return settleState;
  }

  private renderPlannerTail(goal: string, constraints: readonly ArtexTaskConstraint[]): string {
    const parts: string[] = [ARTEX_UNTRUSTED_DATA_RULES];
    const noise = resolveArtexNoiseProfile(this.config);
    const noiseBlock = renderArtexNoiseProfile({
      name: noise.name,
      rps: noise.rps,
      maxPerHost: noise.maxPerHost,
    });
    if (noiseBlock.length > 0) parts.push(noiseBlock);
    if (goal.trim().length > 0) parts.push(`Goal: ${goal.trim()}`);
    const constraintText = renderConstraintBlock(constraints);
    if (constraintText.length > 0) {
      parts.push(constraintText);
    }
    return parts.join('\n\n');
  }

  private renderWorkerTail(): string {
    const parts: string[] = [ARTEX_UNTRUSTED_CONTENT_RULES];
    const noise = resolveArtexNoiseProfile(this.config);
    const noiseBlock = renderArtexNoiseProfile({
      name: noise.name,
      rps: noise.rps,
      maxPerHost: noise.maxPerHost,
    });
    if (noiseBlock.length > 0) parts.push(noiseBlock);
    return parts.join('\n\n');
  }

  private async settle(
    store: IArtexGraphStore,
    claim: ArtexClaimedIntent,
    state: ArtexIntentSettleState,
    result: SessionSwarmRunResult<ArtexClaimedIntent>,
  ): Promise<void> {
    try {
      await store.settleIntentClaim(claim.intentId, claim.token, state);
    } catch {
      return;
    }
    await store
      .mergeNodePayload(claim.intentId, {
        worker_output: result.result ?? result.error ?? '',
        worker_agent_id: result.agentId,
        terminal_reason: normalizeArtexTerminalReason({
          status: result.status,
          stopReason: result.stopReason,
        }),
      })
      .catch(() => undefined);
    await store
      .appendActivity({
        nodeId: claim.intentId,
        actor: 'orchestrator',
        kind: `settle:${state}`,
        summary: `settled ${state}`,
        detail: { agentId: result.agentId, stopReason: result.stopReason },
      })
      .catch(() => undefined);
  }
}
