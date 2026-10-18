import { randomUUID } from 'node:crypto';

import {
  isUserTurnOrigin,
  type FeedbackSurveyEvent,
  type PromptOrigin,
} from '@moonshot-ai/agent-core-v2';

import type { RatingCooldownStore } from './cooldownStore';
import {
  buildSurveyEventProperties,
  SURVEY_EVENT_NAMES,
  type SurveyEventEnvironmentFields,
  type SurveyEventName,
} from './eventProperties';
import {
  evaluateSurveyGate,
  RATING_IDLE_STABILITY_MS,
  type LongContextArmGateInput,
  type SessionArmGateInput,
} from './gates';
import { kfcModelIdOf, type RatingModelRoute } from './kfc';
import {
  SURVEY_MACHINE_CLOSED,
  surveyMachineReduce,
  type RatingResponse,
  type SurveyAppearance,
  type SurveyKind,
  type SurveyMachineAction,
  type SurveyMachineEffect,
  type SurveyMachineState,
} from './machine';
import {
  resolveSurveyPopupConfig,
  type SurveyPopupConfig,
  type SurveyPopupPayload,
} from './surveyPopupConfig';

export const SESSION_RATING_IDLE_MS = RATING_IDLE_STABILITY_MS;
export const SESSION_RATING_EARLY_TOLERANCE_MS = 250;
export const SESSION_RATING_EVALUATION_WINDOW_MS = 10_000;
export const SESSION_RATING_UNDO_WINDOW_MS = 3000;
export const SESSION_RATING_THANKS_MS = 5000;

const SESSION_INIT_PARENT_TOOL_CALL_ID = 'generate-agents-md';
const TOWER_WORKER_PROFILE_NAME = 'tower-worker';

export type RatingView =
  | { readonly phase: 'closed' }
  | { readonly phase: 'open'; readonly appearanceId: string; readonly survey: SurveyKind }
  | {
      readonly phase: 'pending';
      readonly appearanceId: string;
      readonly survey: SurveyKind;
      readonly response: RatingResponse;
      readonly settleInMs: number;
    }
  | {
      readonly phase: 'thanks';
      readonly appearanceId: string;
      readonly survey: SurveyKind;
      readonly response: RatingResponse;
      readonly closeInMs: number;
    };

export const CLOSED_RATING_VIEW: RatingView = { phase: 'closed' };

export type SessionFact =
  | { readonly kind: 'turn-started'; readonly origin: PromptOrigin | undefined }
  | { readonly kind: 'turn-ended'; readonly traceId?: string }
  | { readonly kind: 'tool-call-started'; readonly toolCallId: string; readonly toolName: string }
  | { readonly kind: 'tool-call-ended'; readonly toolCallId: string }
  | {
      readonly kind: 'subagent-spawned';
      readonly parentToolCallId?: string;
      readonly swarmIndex?: number;
      readonly model?: string;
    }
  | { readonly kind: 'compaction-completed' };

export type RatingAction =
  | { readonly type: 'select'; readonly appearanceId: string; readonly response: RatingResponse }
  | { readonly type: 'undo'; readonly appearanceId: string }
  | { readonly type: 'dismiss'; readonly appearanceId: string }
  | { readonly type: 'displace'; readonly appearanceId: string };

export type SessionRatingMountEnd = 'unmount' | 'exit';

export interface ResumedAgentSeed {
  readonly type: string;
  readonly profileName?: string;
  readonly swarmItem?: string;
  readonly sessionInit?: string;
}

export interface RatingEnvironment {
  readonly sessionId: string;
  readonly currentModel: string;
  readonly model: RatingModelRoute;
  readonly cumulativeTokens: number;
  readonly contextTokens: number;
  readonly permissionMode: string;
  readonly thinkingEffort: string;
  readonly busy: boolean;
  readonly telemetryDisabled: boolean;
  readonly ratingDisabled: boolean;
  readonly historyUserTurnCount?: number;
  readonly resumedAgents?: Readonly<Record<string, ResumedAgentSeed>>;
}

export interface RatingTrackContext {
  readonly sessionId: string;
}

export interface RatingConfigFeed {
  readyForEvaluation(): boolean;
  payload(): SurveyPopupPayload;
}

export interface SessionRatingDeps {
  readonly environment: () => RatingEnvironment;
  readonly config: RatingConfigFeed;
  readonly cooldown: RatingCooldownStore;
  readonly track: (
    event: SurveyEventName,
    properties: FeedbackSurveyEvent,
    context: RatingTrackContext,
  ) => void;
  readonly onViewChange?: (view: RatingView) => void;
  readonly now?: () => number;
  readonly wallNow?: () => number;
  readonly random?: () => number;
  readonly appearanceId?: () => string;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface SessionRatingMount {
  observe(fact: SessionFact): void;
  evaluate(): Promise<RatingView>;
  act(action: RatingAction): RatingView;
  view(): RatingView;
  end(kind: SessionRatingMountEnd): void;
}

export function mountSessionRating(deps: SessionRatingDeps): SessionRatingMount {
  return new SessionRatingMountImpl(deps);
}

interface AppearanceSnapshot {
  readonly sessionId: string;
  readonly config: SurveyPopupConfig;
  readonly fields: SurveyEventEnvironmentFields;
}

interface PhaseTimer {
  readonly handle: unknown;
  readonly deadline: number;
}

function recordModel(models: Set<string>, model: string | undefined): void {
  if (model === undefined || model.length === 0) return;
  models.add(model);
}

function joinModels(models: ReadonlySet<string>): string | undefined {
  if (models.size === 0) return undefined;
  return [...models].toSorted().join(',');
}

function resumedSubagentCount(
  agents: Readonly<Record<string, ResumedAgentSeed>> | undefined,
): number {
  if (agents === undefined) return 0;
  return Object.values(agents).filter(
    (agent) =>
      agent.type === 'sub' &&
      agent.swarmItem === undefined &&
      agent.sessionInit === undefined &&
      agent.profileName !== TOWER_WORKER_PROFILE_NAME,
  ).length;
}

class SessionRatingMountImpl implements SessionRatingMount {
  private machine: SurveyMachineState = SURVEY_MACHINE_CLOSED;
  private ended = false;
  private generation = 0;
  private readonly mountedAt: number;
  private currentTurnUserOrigin: boolean | undefined;
  private turnInProgress = false;
  private evaluationPending = false;
  private pendingTraceId: string | undefined;
  private idleSince: number | undefined;
  private userTurnsSinceMount = 0;
  private lastShownAt: number | undefined;
  private userTurnsAtLastShown: number | undefined;
  private appearanceCount = 0;
  private globalLastShownAt: number | undefined;
  private readonly longContextRollConsumedModels = new Set<string | undefined>();
  private longContextShownThisMount = false;
  private stickySample: { readonly turnCount: number; readonly value: number } | undefined;
  private toolCallCount = 0;
  private compactionCount = 0;
  private subagentsSpawned = 0;
  private readonly subagentModels = new Set<string>();
  private swarmRunCount = 0;
  private readonly swarmModels = new Set<string>();
  private readonly toolCallFamilies = new Map<string, string>();
  private snapshot: AppearanceSnapshot | undefined;
  private phaseTimer: PhaseTimer | undefined;

  constructor(private readonly deps: SessionRatingDeps) {
    this.mountedAt = this.now();
  }

  observe(fact: SessionFact): void {
    if (this.ended) return;
    switch (fact.kind) {
      case 'turn-started':
        this.turnStarted(isUserTurnOrigin(fact.origin) === true);
        return;
      case 'turn-ended':
        this.turnEnded(fact.traceId);
        return;
      case 'tool-call-started':
        this.toolCallCount += 1;
        this.toolCallFamilies.set(fact.toolCallId, fact.toolName);
        if (fact.toolName === 'AgentSwarm') this.swarmRunCount += 1;
        return;
      case 'tool-call-ended':
        this.toolCallFamilies.delete(fact.toolCallId);
        return;
      case 'subagent-spawned':
        this.subagentSpawned(fact);
        return;
      case 'compaction-completed':
        this.compactionCount += 1;
    }
  }

  async evaluate(): Promise<RatingView> {
    if (!this.takeEvaluationSlot()) return this.view();
    try {
      await this.evaluateGates();
    } catch {}
    return this.view();
  }

  act(action: RatingAction): RatingView {
    if (!this.ended && this.machine.appearance?.appearanceId === action.appearanceId) {
      this.apply(this.machineActionFor(action));
    }
    return this.view();
  }

  view(): RatingView {
    const { phase, appearance, response } = this.machine;
    if (phase === 'closed' || appearance === undefined) return CLOSED_RATING_VIEW;
    const base = { appearanceId: appearance.appearanceId, survey: appearance.survey };
    if (phase === 'open') return { phase, ...base };
    if (response === undefined || response === 'dismissed') return CLOSED_RATING_VIEW;
    const remaining =
      this.phaseTimer === undefined
        ? 0
        : Math.max(0, Math.round(this.phaseTimer.deadline - this.now()));
    return phase === 'pending'
      ? { phase, ...base, response, settleInMs: remaining }
      : { phase, ...base, response, closeInMs: remaining };
  }

  end(kind: SessionRatingMountEnd): void {
    if (this.ended) return;
    if (kind === 'unmount') this.displace();
    this.clearPhaseTimer();
    this.machine = SURVEY_MACHINE_CLOSED;
    this.ended = true;
    this.generation += 1;
  }

  private turnStarted(userOrigin: boolean): void {
    if (this.slotElapsed()) this.evaluationPending = false;
    this.generation += 1;
    this.currentTurnUserOrigin = userOrigin;
    this.turnInProgress = true;
    this.idleSince = undefined;
    this.displace();
    if (!userOrigin) return;
    this.userTurnsSinceMount += 1;
    this.evaluationPending = false;
    this.pendingTraceId = undefined;
  }

  private turnEnded(traceId: string | undefined): void {
    if (this.currentTurnUserOrigin === true) {
      this.evaluationPending = true;
      this.pendingTraceId = traceId;
    }
    this.currentTurnUserOrigin = undefined;
    this.turnInProgress = false;
    if (this.evaluationPending) this.idleSince = this.now();
  }

  private subagentSpawned(fact: Extract<SessionFact, { kind: 'subagent-spawned' }>): void {
    if (fact.parentToolCallId === SESSION_INIT_PARENT_TOOL_CALL_ID) return;
    const toolName =
      fact.parentToolCallId === undefined
        ? undefined
        : this.toolCallFamilies.get(fact.parentToolCallId);
    if (toolName === 'Agent') {
      this.subagentsSpawned += 1;
      recordModel(this.subagentModels, fact.model);
      return;
    }
    if (toolName === 'AgentSwarm') {
      recordModel(this.swarmModels, fact.model);
      return;
    }
    if (toolName !== undefined) return;
    if (fact.swarmIndex !== undefined) {
      recordModel(this.swarmModels, fact.model);
      return;
    }
    this.subagentsSpawned += 1;
    recordModel(this.subagentModels, fact.model);
  }

  private slotElapsed(): boolean {
    return (
      this.evaluationPending &&
      this.idleSince !== undefined &&
      this.now() - this.idleSince >= SESSION_RATING_IDLE_MS
    );
  }

  private takeEvaluationSlot(): boolean {
    if (this.ended || !this.evaluationPending || this.turnInProgress) return false;
    if (this.idleSince === undefined) return false;
    const idleFor = this.now() - this.idleSince;
    if (idleFor < SESSION_RATING_IDLE_MS - SESSION_RATING_EARLY_TOLERANCE_MS) return false;
    this.evaluationPending = false;
    return (
      idleFor <= SESSION_RATING_IDLE_MS + SESSION_RATING_EVALUATION_WINDOW_MS &&
      this.machine.phase === 'closed'
    );
  }

  private async evaluateGates(): Promise<void> {
    if (!this.deps.config.readyForEvaluation()) return;
    const generation = this.generation;
    const idleSince = this.idleSince ?? this.now();
    const idleShortfall = SESSION_RATING_IDLE_MS - (this.now() - idleSince);
    if (idleShortfall > 0) await this.delay(idleShortfall);
    const persisted = await this.deps.cooldown.read().catch(() => undefined);
    if (this.ended || generation !== this.generation || this.machine.phase !== 'closed') return;
    if (persisted !== undefined) {
      this.globalLastShownAt = Math.max(persisted, this.globalLastShownAt ?? 0);
    }
    const environment = this.deps.environment();
    const kfcModelId = kfcModelIdOf(environment.model);
    const config = resolveSurveyPopupConfig(this.deps.config.payload(), kfcModelId);
    const verdict = evaluateSurveyGate({ ...this.gateInputs(environment, kfcModelId), config });
    if (verdict.longContextRollConsumed === true) {
      this.longContextRollConsumedModels.add(kfcModelId);
    }
    if (verdict.show) this.open(verdict.survey, config, environment, kfcModelId);
  }

  private gateInputs(
    environment: RatingEnvironment,
    kfcModelId: string | undefined,
  ): { session: SessionArmGateInput; longContext: LongContextArmGateInput } {
    const now = this.now();
    const shared = {
      phase: this.machine.phase,
      turnInProgress: this.turnInProgress || environment.busy,
      idleForMs: this.idleSince === undefined ? 0 : now - this.idleSince,
      feedbackSurveyDisabled: environment.ratingDisabled,
      telemetryDisabled: environment.telemetryDisabled,
      kfcModelId,
    };
    const msSinceGlobalLastShown =
      this.globalLastShownAt === undefined ? undefined : this.wallNow() - this.globalLastShownAt;
    return {
      session: {
        ...shared,
        mountedForMs: now - this.mountedAt,
        userTurnsSinceMount: this.userTurnsSinceMount,
        msSinceLastShown: this.lastShownAt === undefined ? undefined : now - this.lastShownAt,
        userTurnsSinceLastShown:
          this.userTurnsAtLastShown === undefined
            ? undefined
            : this.userTurnsSinceMount - this.userTurnsAtLastShown,
        sample: this.currentSample(),
        msSinceGlobalLastShown,
      },
      longContext: {
        ...shared,
        cumulativeTokens: environment.cumulativeTokens,
        virtualContextTokens: environment.contextTokens,
        mountRollConsumed: this.longContextRollConsumedModels.has(kfcModelId),
        mountSurveyShown: this.longContextShownThisMount,
        msSinceGlobalLastShown,
        drawMountRoll: () => this.random(),
      },
    };
  }

  private currentSample(): number {
    if (this.stickySample?.turnCount !== this.userTurnsSinceMount) {
      this.stickySample = { turnCount: this.userTurnsSinceMount, value: this.random() };
    }
    return this.stickySample.value;
  }

  private open(
    survey: SurveyKind,
    config: SurveyPopupConfig,
    environment: RatingEnvironment,
    kfcModelId: string | undefined,
  ): void {
    this.appearanceCount += 1;
    const appearance: SurveyAppearance = {
      survey,
      appearanceId: (this.deps.appearanceId ?? randomUUID)(),
      appearanceIndex: this.appearanceCount,
    };
    const shownAt = this.now();
    this.snapshot = {
      sessionId: environment.sessionId,
      config,
      fields: this.environmentFields(environment, kfcModelId),
    };
    this.pendingTraceId = undefined;
    this.apply({ type: 'open', appearance });
    if (this.machine.phase !== 'open') return;
    this.lastShownAt = shownAt;
    this.userTurnsAtLastShown = this.userTurnsSinceMount;
    if (survey === 'long_context') this.longContextShownThisMount = true;
    const wallTime = this.wallNow();
    this.globalLastShownAt = wallTime;
    void this.deps.cooldown.write(wallTime).catch(() => undefined);
  }

  private environmentFields(
    environment: RatingEnvironment,
    kfcModelId: string | undefined,
  ): SurveyEventEnvironmentFields {
    return {
      current_model: environment.currentModel,
      kfc_model_id: kfcModelId,
      kfc_trace_id: kfcModelId === undefined ? undefined : this.pendingTraceId,
      user_turn_count:
        environment.historyUserTurnCount === undefined
          ? undefined
          : environment.historyUserTurnCount + this.userTurnsSinceMount,
      cumulative_tokens: environment.cumulativeTokens,
      virtual_context_tokens: environment.contextTokens,
      tool_call_count: this.toolCallCount,
      compaction_count: this.compactionCount,
      permission_mode: environment.permissionMode,
      thinking_effort: environment.thinkingEffort,
      subagent_count: resumedSubagentCount(environment.resumedAgents) + this.subagentsSpawned,
      subagent_models: joinModels(this.subagentModels),
      swarm_run_count: this.swarmRunCount,
      swarm_models: joinModels(this.swarmModels),
    };
  }

  private displace(): void {
    if (this.machine.phase === 'open') {
      this.apply({ type: 'abandon' });
      return;
    }
    if (this.machine.phase !== 'closed') this.apply({ type: 'close-silently' });
  }

  private machineActionFor(action: RatingAction): SurveyMachineAction {
    switch (action.type) {
      case 'select':
        return { type: 'select', response: action.response };
      case 'undo':
        return { type: 'undo' };
      case 'dismiss':
        return this.machine.phase === 'thanks' ? { type: 'close-silently' } : { type: 'dismiss' };
      case 'displace':
        return this.machine.phase === 'open' ? { type: 'abandon' } : { type: 'close-silently' };
    }
  }

  private apply(action: SurveyMachineAction): void {
    const previous = this.machine;
    const transition = surveyMachineReduce(previous, action);
    if (transition.state === previous && transition.effects.length === 0) return;
    this.clearPhaseTimer();
    const appearance = transition.state.appearance ?? previous.appearance;
    this.machine = transition.state;
    for (const effect of transition.effects) this.runEffect(effect, appearance);
    this.deps.onViewChange?.(this.view());
  }

  private runEffect(effect: SurveyMachineEffect, appearance: SurveyAppearance | undefined): void {
    if (effect.type === 'schedule') {
      if (effect.timer === 'pending-settle') {
        this.schedule(SESSION_RATING_UNDO_WINDOW_MS, { type: 'settle' });
      } else {
        this.schedule(SESSION_RATING_THANKS_MS, { type: 'thanks-elapsed' });
      }
      return;
    }
    if (appearance === undefined || this.snapshot === undefined) return;
    const properties = buildSurveyEventProperties(
      {
        event_type: effect.eventType,
        appearance_id: appearance.appearanceId,
        appearance_index: appearance.appearanceIndex,
        response: effect.response,
      },
      this.snapshot.fields,
      this.snapshot.config,
    );
    try {
      this.deps.track(SURVEY_EVENT_NAMES[appearance.survey], properties, {
        sessionId: this.snapshot.sessionId,
      });
    } catch {}
  }

  private schedule(ms: number, action: SurveyMachineAction): void {
    const handle = this.setTimer(() => {
      this.phaseTimer = undefined;
      this.apply(action);
    }, ms);
    this.phaseTimer = { handle, deadline: this.now() + ms };
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer === undefined) return;
    this.clearTimer(this.phaseTimer.handle);
    this.phaseTimer = undefined;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimer(resolve, ms);
    });
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay)))(
      fn,
      ms,
    );
  }

  private clearTimer(handle: unknown): void {
    (
      this.deps.clearTimer ??
      ((value: unknown) => {
        clearTimeout(value as Parameters<typeof clearTimeout>[0]);
      })
    )(handle);
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }

  private wallNow(): number {
    return (this.deps.wallNow ?? Date.now)();
  }

  private random(): number {
    return (this.deps.random ?? Math.random)();
  }
}
