import type { FeedbackSurveyEvent } from '@moonshot-ai/agent-core-v2';

import type { SurveyEventType, SurveyKind, SurveyResponse } from '../common/types';
import type { SurveyPopupConfig } from '../common/survey-popup-config';

export const SURVEY_EVENT_NAMES = {
  session: 'feedback_survey',
  long_context: 'long_context_survey',
} as const satisfies Record<SurveyKind, string>;

export type SurveyEventName = (typeof SURVEY_EVENT_NAMES)[SurveyKind];

export interface SurveyEventCoreFields {
  readonly event_type: SurveyEventType;
  readonly appearance_id: string;
  readonly appearance_index: number;
  readonly response?: SurveyResponse;
}

export interface SurveyEventEnvironmentFields {
  readonly current_model: string;
  readonly kfc_model_id?: string;
  readonly kfc_trace_id?: string;
  readonly user_turn_count?: number;
  readonly cumulative_tokens: number;
  readonly virtual_context_tokens: number;
  readonly tool_call_count: number;
  readonly compaction_count: number;
  readonly permission_mode: string;
  readonly thinking_effort: string;
  readonly subagent_count: number;
  readonly subagent_models?: string;
  readonly swarm_run_count: number;
  readonly swarm_models?: string;
}

export function buildSurveyEventProperties(
  core: SurveyEventCoreFields,
  environment: SurveyEventEnvironmentFields,
  config: SurveyPopupConfig,
): FeedbackSurveyEvent {
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
