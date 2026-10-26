import type { SurveyKind } from './types';
import type { SurveyPopupConfig } from './survey-popup-config';

export type SurveyGateSkipReason =
  | 'mount-roll-consumed'
  | 'mount-survey-shown'
  | 'turn-in-progress'
  | 'feature-disabled'
  | 'telemetry-disabled'
  | 'model-gated'
  | 'warmup'
  | 'pacing'
  | 'threshold-invalid'
  | 'below-threshold'
  | 'sampled-out'
  | 'global-cooldown';

export interface SharedArmGateInput {
  readonly turnInProgress: boolean;
  readonly feedbackSurveyDisabled: boolean;
  readonly telemetryDisabled: boolean;
  readonly kfcModelId: string | undefined;
}

export interface SessionArmGateInput extends SharedArmGateInput {
  readonly mountedForMs: number;
  readonly userTurnsSinceMount: number;
  readonly msSinceLastShown: number | undefined;
  readonly userTurnsSinceLastShown: number | undefined;
  readonly sample: number;
  readonly msSinceGlobalLastShown: number | undefined;
}

export interface LongContextArmGateInput extends SharedArmGateInput {
  readonly cumulativeTokens: number;
  readonly virtualContextTokens: number;
  readonly mountRollConsumed: boolean;
  readonly mountSurveyShown: boolean;
  readonly msSinceGlobalLastShown: number | undefined;
  readonly drawMountRoll: () => number;
}

export interface SurveyGateInput {
  readonly session: SessionArmGateInput;
  readonly longContext: LongContextArmGateInput;
  readonly config: SurveyPopupConfig;
}

export type SurveyGateVerdict =
  | {
      readonly show: true;
      readonly survey: SurveyKind;
      readonly longContextRollConsumed?: boolean;
    }
  | {
      readonly show: false;
      readonly reason: SurveyGateSkipReason;
      readonly longContextRollConsumed?: boolean;
    };

function modelGatePasses(onForModels: readonly string[], kfcModelId: string | undefined): boolean {
  if (onForModels.length === 0) return false;
  if (onForModels.includes('*')) return true;
  return kfcModelId !== undefined && onForModels.includes(kfcModelId);
}

function sharedSkipReason(
  input: SharedArmGateInput,
  config: SurveyPopupConfig,
): SurveyGateSkipReason | undefined {
  if (input.turnInProgress) return 'turn-in-progress';
  if (input.feedbackSurveyDisabled) return 'feature-disabled';
  if (input.telemetryDisabled) return 'telemetry-disabled';
  if (!modelGatePasses(config.on_for_models, input.kfcModelId)) return 'model-gated';
  return undefined;
}

function evaluateSessionArm(input: SurveyGateInput): SurveyGateVerdict {
  const { session, config } = input;
  const shared = sharedSkipReason(session, config);
  if (shared !== undefined) return { show: false, reason: shared };
  if (session.msSinceLastShown === undefined) {
    if (
      session.mountedForMs < config.min_time_before_feedback_ms ||
      session.userTurnsSinceMount < config.min_user_turns_before_feedback
    ) {
      return { show: false, reason: 'warmup' };
    }
  } else if (
    session.msSinceLastShown < config.min_time_between_feedback_ms ||
    (session.userTurnsSinceLastShown ?? 0) < config.min_user_turns_between_feedback
  ) {
    return { show: false, reason: 'pacing' };
  }
  if (session.sample >= config.probability) return { show: false, reason: 'sampled-out' };
  if (
    session.msSinceGlobalLastShown !== undefined &&
    session.msSinceGlobalLastShown < config.min_time_between_global_feedback_ms
  ) {
    return { show: false, reason: 'global-cooldown' };
  }
  return { show: true, survey: 'session' };
}

export function evaluateLongContextArm(input: SurveyGateInput): SurveyGateVerdict {
  const { longContext, config } = input;
  if (longContext.mountSurveyShown) return { show: false, reason: 'mount-survey-shown' };
  if (longContext.mountRollConsumed) return { show: false, reason: 'mount-roll-consumed' };
  const shared = sharedSkipReason(longContext, config);
  if (shared !== undefined) return { show: false, reason: shared };
  if (!(config.long_context_survey_threshold > 0)) {
    return { show: false, reason: 'threshold-invalid' };
  }
  const counter =
    config.long_context_trigger_mode === 'cumulative'
      ? longContext.cumulativeTokens
      : longContext.virtualContextTokens;
  if (counter < config.long_context_survey_threshold) {
    return { show: false, reason: 'below-threshold' };
  }
  if (
    longContext.msSinceGlobalLastShown !== undefined &&
    longContext.msSinceGlobalLastShown < config.min_time_between_global_feedback_ms
  ) {
    return { show: false, reason: 'global-cooldown' };
  }
  if (longContext.drawMountRoll() >= config.long_context_probability) {
    return { show: false, reason: 'sampled-out', longContextRollConsumed: true };
  }
  return { show: true, survey: 'long_context', longContextRollConsumed: true };
}

export function evaluateSurveyGate(input: SurveyGateInput): SurveyGateVerdict {
  const longContext = evaluateLongContextArm(input);
  if (longContext.show) return longContext;
  const session = evaluateSessionArm(input);
  if (longContext.longContextRollConsumed === true) {
    return { ...session, longContextRollConsumed: true };
  }
  return session;
}
