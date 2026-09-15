
import type { SurveyPopupConfig } from '#/utils/survey-popup-config';

import {
  SURVEY_IDLE_STABILITY_MS,
  SURVEY_MIN_OPTIONS_WIDTH,
  surveyMinTotalHeight,
} from '../constant/survey';

export type SurveyKind = 'session' | 'long_context';

export type SurveyGateSkipReason =
  | 'mount-roll-consumed'
  | 'survey-active'
  | 'turn-in-progress'
  | 'idle-too-short'
  | 'ordered-list-ambiguity'
  | 'prompt-active'
  | 'editor-bash-active'
  | 'editor-autocomplete-active'
  | 'external-editor-active'
  | 'terminal-too-narrow'
  | 'terminal-too-short'
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
  readonly phase: SurveyPhase;
  readonly turnInProgress: boolean;
  readonly idleForMs: number;
  readonly promptActive: boolean;
  readonly editorBashActive: boolean;
  readonly editorAutocompleteActive: boolean;
  readonly externalEditorActive: boolean;
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  readonly feedbackSurveyDisabled: boolean;
  readonly telemetryDisabled: boolean;
  readonly currentModel: string;
  readonly lastUserMessageStartsOrderedList: boolean;
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

function modelGatePasses(onForModels: readonly string[], currentModel: string): boolean {
  if (onForModels.length === 0) return false;
  if (onForModels.includes('*')) return true;
  return onForModels.includes(currentModel);
}

function evaluateSessionArm(input: SurveyGateInput): SurveyGateVerdict {
  const { session, config } = input;
  if (session.phase !== 'closed') return { show: false, reason: 'survey-active' };
  if (session.turnInProgress) return { show: false, reason: 'turn-in-progress' };
  if (session.idleForMs < SURVEY_IDLE_STABILITY_MS) {
    return { show: false, reason: 'idle-too-short' };
  }
  if (session.lastUserMessageStartsOrderedList) {
    return { show: false, reason: 'ordered-list-ambiguity' };
  }
  if (session.promptActive) return { show: false, reason: 'prompt-active' };
  if (session.editorBashActive) return { show: false, reason: 'editor-bash-active' };
  if (session.editorAutocompleteActive) {
    return { show: false, reason: 'editor-autocomplete-active' };
  }
  if (session.externalEditorActive) {
    return { show: false, reason: 'external-editor-active' };
  }
  if (session.terminalWidth < SURVEY_MIN_OPTIONS_WIDTH) {
    return { show: false, reason: 'terminal-too-narrow' };
  }
  if (session.terminalHeight < surveyMinTotalHeight(session.terminalWidth)) {
    return { show: false, reason: 'terminal-too-short' };
  }
  if (session.feedbackSurveyDisabled) return { show: false, reason: 'feature-disabled' };
  if (session.telemetryDisabled) return { show: false, reason: 'telemetry-disabled' };
  if (!modelGatePasses(config.on_for_models, session.currentModel)) {
    return { show: false, reason: 'model-gated' };
  }
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
  if (longContext.mountRollConsumed) return { show: false, reason: 'mount-roll-consumed' };
  if (longContext.phase !== 'closed') return { show: false, reason: 'survey-active' };
  if (longContext.turnInProgress) return { show: false, reason: 'turn-in-progress' };
  if (longContext.idleForMs < SURVEY_IDLE_STABILITY_MS) {
    return { show: false, reason: 'idle-too-short' };
  }
  if (longContext.lastUserMessageStartsOrderedList) {
    return { show: false, reason: 'ordered-list-ambiguity' };
  }
  if (longContext.promptActive) return { show: false, reason: 'prompt-active' };
  if (longContext.editorBashActive) return { show: false, reason: 'editor-bash-active' };
  if (longContext.editorAutocompleteActive) {
    return { show: false, reason: 'editor-autocomplete-active' };
  }
  if (longContext.externalEditorActive) {
    return { show: false, reason: 'external-editor-active' };
  }
  if (longContext.terminalWidth < SURVEY_MIN_OPTIONS_WIDTH) {
    return { show: false, reason: 'terminal-too-narrow' };
  }
  if (longContext.terminalHeight < surveyMinTotalHeight(longContext.terminalWidth)) {
    return { show: false, reason: 'terminal-too-short' };
  }
  if (longContext.feedbackSurveyDisabled) return { show: false, reason: 'feature-disabled' };
  if (longContext.telemetryDisabled) return { show: false, reason: 'telemetry-disabled' };
  if (!modelGatePasses(config.on_for_models, longContext.currentModel)) {
    return { show: false, reason: 'model-gated' };
  }
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

export type SurveyPhase = 'closed' | 'open' | 'pending' | 'thanks';

export type SurveyResponse = 'bad' | 'fine' | 'good' | 'dismissed';

export type SurveyEventType = 'appeared' | 'responded' | 'abandoned';

export interface SurveyAppearance {
  readonly survey: SurveyKind;
  readonly appearanceId: string;
  readonly appearanceIndex: number;
}

export interface SurveyMachineState {
  readonly phase: SurveyPhase;
  readonly appearance: SurveyAppearance | undefined;
  readonly response: SurveyResponse | undefined;
}

export const SURVEY_MACHINE_CLOSED: SurveyMachineState = {
  phase: 'closed',
  appearance: undefined,
  response: undefined,
};

const SURVEY_PRIORITY: Record<SurveyKind, number> = { session: 0, long_context: 1 };

export type SurveyMachineAction =
  | { readonly type: 'open'; readonly appearance: SurveyAppearance }
  | { readonly type: 'select'; readonly response: 'bad' | 'fine' | 'good' }
  | { readonly type: 'dismiss' }
  | { readonly type: 'undo' }
  | { readonly type: 'settle' }
  | { readonly type: 'thanks-elapsed' }
  | { readonly type: 'abandon' }
  | { readonly type: 'close-silently' };

export type SurveyMachineEffect =
  | {
      readonly type: 'report';
      readonly eventType: SurveyEventType;
      readonly response?: SurveyResponse;
    }
  | { readonly type: 'schedule'; readonly timer: 'pending-settle' | 'thanks-close' };

export interface SurveyMachineTransition {
  readonly state: SurveyMachineState;
  readonly effects: readonly SurveyMachineEffect[];
}

const NO_EFFECTS: readonly SurveyMachineEffect[] = [];

function noTransition(state: SurveyMachineState): SurveyMachineTransition {
  return { state, effects: NO_EFFECTS };
}

export function surveyMachineReduce(
  state: SurveyMachineState,
  action: SurveyMachineAction,
): SurveyMachineTransition {
  switch (action.type) {
    case 'open': {
      if (state.phase === 'closed') {
        return {
          state: { phase: 'open', appearance: action.appearance, response: undefined },
          effects: [{ type: 'report', eventType: 'appeared' }],
        };
      }
      if (state.phase !== 'open' || state.appearance === undefined) {
        return noTransition(state);
      }
      if (SURVEY_PRIORITY[action.appearance.survey] <= SURVEY_PRIORITY[state.appearance.survey]) {
        return noTransition(state);
      }
      return {
        state: { phase: 'open', appearance: action.appearance, response: undefined },
        effects: [{ type: 'report', eventType: 'appeared' }],
      };
    }
    case 'select': {
      if (state.phase !== 'open') return noTransition(state);
      return {
        state: { ...state, phase: 'pending', response: action.response },
        effects: [{ type: 'schedule', timer: 'pending-settle' }],
      };
    }
    case 'dismiss': {
      if (state.phase !== 'open') return noTransition(state);
      return {
        state: SURVEY_MACHINE_CLOSED,
        effects: [{ type: 'report', eventType: 'responded', response: 'dismissed' }],
      };
    }
    case 'undo': {
      if (state.phase !== 'pending') return noTransition(state);
      return {
        state: { ...state, phase: 'open', response: undefined },
        effects: NO_EFFECTS,
      };
    }
    case 'settle': {
      if (state.phase !== 'pending' || state.response === undefined) {
        return noTransition(state);
      }
      return {
        state: { ...state, phase: 'thanks' },
        effects: [
          { type: 'report', eventType: 'responded', response: state.response },
          { type: 'schedule', timer: 'thanks-close' },
        ],
      };
    }
    case 'thanks-elapsed': {
      if (state.phase !== 'thanks') return noTransition(state);
      return { state: SURVEY_MACHINE_CLOSED, effects: NO_EFFECTS };
    }
    case 'abandon': {
      if (state.phase !== 'open') return noTransition(state);
      return {
        state: SURVEY_MACHINE_CLOSED,
        effects: [{ type: 'report', eventType: 'abandoned' }],
      };
    }
    case 'close-silently': {
      if (state.phase === 'closed') return noTransition(state);
      if (state.phase === 'pending' && state.response !== undefined) {
        return {
          state: SURVEY_MACHINE_CLOSED,
          effects: [{ type: 'report', eventType: 'responded', response: state.response }],
        };
      }
      return { state: SURVEY_MACHINE_CLOSED, effects: NO_EFFECTS };
    }
  }
}

export const SURVEY_EVENT_NAMES: Record<SurveyKind, string> = {
  session: 'feedback_survey',
  long_context: 'long_context_survey',
};

export interface SurveyEventCoreFields {
  readonly event_type: SurveyEventType;
  readonly appearance_id: string;
  readonly appearance_index: number;
  readonly response?: SurveyResponse;
}

export interface SurveyEventEnvironmentFields {
  readonly current_model: string;
  readonly user_turn_count: number;
  readonly cumulative_tokens: number;
  readonly virtual_context_tokens: number;
  readonly tool_call_count: number;
  readonly compaction_count: number;
  readonly permission_mode: string;
  readonly thinking_effort: string;
}

export function buildSurveyEventProperties(
  core: SurveyEventCoreFields,
  environment: SurveyEventEnvironmentFields,
  config: SurveyPopupConfig,
): Record<string, string | number | undefined> {
  return {
    event_type: core.event_type,
    appearance_id: core.appearance_id,
    appearance_index: core.appearance_index,
    response: core.response,
    ...environment,
    config_probability: config.probability,
    config_on_for_models: config.on_for_models.join(','),
    config_min_time_before_feedback_ms: config.min_time_before_feedback_ms,
    config_min_user_turns_before_feedback: config.min_user_turns_before_feedback,
    config_min_time_between_feedback_ms: config.min_time_between_feedback_ms,
    config_min_user_turns_between_feedback: config.min_user_turns_between_feedback,
    config_min_time_between_global_feedback_ms: config.min_time_between_global_feedback_ms,
    config_long_context_survey_threshold: config.long_context_survey_threshold,
    config_long_context_probability: config.long_context_probability,
    config_long_context_trigger_mode: config.long_context_trigger_mode,
  };
}
