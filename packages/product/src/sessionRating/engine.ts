import { randomUUID } from 'node:crypto';

import type { FeedbackSurveyEvent, PromptOrigin } from '@moonshot-ai/agent-core-v2';

import {
  buildSurveyEventProperties,
  SURVEY_EVENT_NAMES,
  type SurveyEventEnvironmentFields,
  type SurveyEventName,
} from './eventProperties';
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
import { DEFAULT_SURVEY_POPUP_CONFIG, type SurveyPopupConfig } from './surveyPopupConfig';
import { isUserSubmittedTurnOrigin } from './userTurn';

export const SESSION_RATING_IDLE_MS = 2000;
export const SESSION_RATING_EARLY_TOLERANCE_MS = 250;
export const SESSION_RATING_EVALUATION_WINDOW_MS = 10_000;
export const SESSION_RATING_UNDO_WINDOW_MS = 3000;
export const SESSION_RATING_THANKS_MS = 5000;

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
  | { readonly kind: 'turn-ended'; readonly traceId?: string };

export type RatingAction =
  | { readonly type: 'select'; readonly appearanceId: string; readonly response: RatingResponse }
  | { readonly type: 'undo'; readonly appearanceId: string }
  | { readonly type: 'dismiss'; readonly appearanceId: string };

export type SessionRatingMountEnd = 'unmount' | 'exit';

export interface RatingEnvironment {
  readonly currentModel: string;
  readonly kfcModelId?: string;
  readonly cumulativeTokens: number;
  readonly contextTokens: number;
  readonly permissionMode: string;
  readonly thinkingEffort: string;
}

export interface SessionRatingSeed {
  readonly userTurnCount?: number;
}

export interface SessionRatingDeps {
  readonly environment: () => RatingEnvironment;
  readonly track: (event: SurveyEventName, properties: FeedbackSurveyEvent) => void;
  readonly preview?: boolean;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly appearanceId?: () => string;
}

export interface SessionRatingMount {
  observe(fact: SessionFact): void;
  evaluate(): Promise<RatingView>;
  act(action: RatingAction): RatingView;
  view(): RatingView;
  end(kind: SessionRatingMountEnd): void;
}

export function mountSessionRating(
  seed: SessionRatingSeed,
  deps: SessionRatingDeps,
): SessionRatingMount {
  return new SessionRatingMountImpl(seed, deps);
}

interface AppearanceSnapshot {
  readonly config: SurveyPopupConfig;
  readonly environment: SurveyEventEnvironmentFields;
}

interface PhaseTimer {
  readonly handle: unknown;
  readonly deadline: number;
}

class SessionRatingMountImpl implements SessionRatingMount {
  private machine: SurveyMachineState = SURVEY_MACHINE_CLOSED;
  private ended = false;
  private currentTurnUserOrigin: boolean | undefined;
  private turnInProgress = false;
  private evaluationPending = false;
  private pendingTraceId: string | undefined;
  private idleSince: number | undefined;
  private userTurnsSinceMount = 0;
  private appearanceCount = 0;
  private snapshot: AppearanceSnapshot | undefined;
  private phaseTimer: PhaseTimer | undefined;

  constructor(
    private readonly seed: SessionRatingSeed,
    private readonly deps: SessionRatingDeps,
  ) {}

  observe(fact: SessionFact): void {
    if (this.ended) return;
    switch (fact.kind) {
      case 'turn-started':
        this.turnStarted(isUserSubmittedTurnOrigin(fact.origin));
        return;
      case 'turn-ended':
        this.turnEnded(fact.traceId);
    }
  }

  async evaluate(): Promise<RatingView> {
    if (!this.takeEvaluationSlot()) return this.view();
    if (this.deps.preview === true) this.open('session', DEFAULT_SURVEY_POPUP_CONFIG);
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
  }

  private turnStarted(userOrigin: boolean): void {
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

  private open(survey: SurveyKind, config: SurveyPopupConfig): void {
    this.appearanceCount += 1;
    const appearance: SurveyAppearance = {
      survey,
      appearanceId: (this.deps.appearanceId ?? randomUUID)(),
      appearanceIndex: this.appearanceCount,
    };
    this.snapshot = { config, environment: this.environmentFields(this.pendingTraceId) };
    this.pendingTraceId = undefined;
    this.apply({ type: 'open', appearance });
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
    this.deps.track(
      SURVEY_EVENT_NAMES[appearance.survey],
      buildSurveyEventProperties(
        {
          event_type: effect.eventType,
          appearance_id: appearance.appearanceId,
          appearance_index: appearance.appearanceIndex,
          response: effect.response,
        },
        this.snapshot.environment,
        this.snapshot.config,
      ),
    );
  }

  private schedule(ms: number, action: SurveyMachineAction): void {
    const setTimer = this.deps.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
    const handle = setTimer(() => {
      this.phaseTimer = undefined;
      this.apply(action);
    }, ms);
    this.phaseTimer = { handle, deadline: this.now() + ms };
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer === undefined) return;
    const clearTimer =
      this.deps.clearTimer ??
      ((handle: unknown) => {
        clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
      });
    clearTimer(this.phaseTimer.handle);
    this.phaseTimer = undefined;
  }

  private environmentFields(traceId: string | undefined): SurveyEventEnvironmentFields {
    const environment = this.deps.environment();
    return {
      current_model: environment.currentModel,
      kfc_model_id: environment.kfcModelId,
      kfc_trace_id: environment.kfcModelId === undefined ? undefined : traceId,
      user_turn_count:
        this.seed.userTurnCount === undefined
          ? undefined
          : this.seed.userTurnCount + this.userTurnsSinceMount,
      cumulative_tokens: environment.cumulativeTokens,
      virtual_context_tokens: environment.contextTokens,
      tool_call_count: 0,
      compaction_count: 0,
      permission_mode: environment.permissionMode,
      thinking_effort: environment.thinkingEffort,
      subagent_count: 0,
      subagent_models: undefined,
      swarm_run_count: 0,
      swarm_models: undefined,
    };
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }
}
