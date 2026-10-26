import { defineTelemetryEvent } from '@moonshot-ai/agent-core-v2';

import type { SurveyEventType, SurveyKind, SurveyResponse } from '../common/types';
import type { SurveyPopupConfig } from '../common/survey-popup-config';

export const SURVEY_EVENT_NAMES = {
  session: 'feedback_survey',
  long_context: 'long_context_survey',
} as const satisfies Record<SurveyKind, SurveyEventName>;

export type SurveyEventName = keyof typeof surveyEventDefinitions;

export interface SurveyEventProperties {
  event_type: 'appeared' | 'responded' | 'abandoned';
  appearance_id: string;
  appearance_index: number;
  response?: 'bad' | 'fine' | 'good' | 'dismissed';
  current_model: string;
  kfc_model_id?: string;
  kfc_trace_id?: string;
  user_turn_count?: number;
  cumulative_tokens: number;
  virtual_context_tokens: number;
  tool_call_count: number;
  compaction_count: number;
  permission_mode: string;
  thinking_effort: string;
  subagent_count: number;
  subagent_models?: string;
  swarm_run_count: number;
  swarm_models?: string;
  config_probability: number;
  config_on_for_models: string;
  config_min_time_before_feedback_ms: number;
  config_min_user_turns_before_feedback: number;
  config_min_time_between_feedback_ms: number;
  config_min_user_turns_between_feedback: number;
  config_min_time_between_global_feedback_ms: number;
  config_long_context_survey_threshold: number;
  config_long_context_probability: number;
  config_long_context_trigger_mode: 'cumulative' | 'virtual_context';
}

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

const surveyEventPropertyDescriptions: {
  readonly [K in keyof SurveyEventProperties]-?: string;
} = {
  event_type: 'Lifecycle stage of one prompt appearance: appeared, responded, or abandoned',
  appearance_id: 'Id shared by the lifecycle events of one prompt appearance',
  appearance_index: 'Ordinal of the appearance within the current session mount, starting at 1',
  response: 'Answer carried by responded events: bad, fine, good, or dismissed',
  current_model: 'Session model alias when the prompt appeared',
  kfc_model_id: 'Managed Kimi Code model id, present when the session model uses the managed endpoint',
  kfc_trace_id: 'Trace id of the turn that triggered the prompt, present only with kfc_model_id',
  user_turn_count:
    'User turns in the session when the prompt appeared, absent when the history count is unknown',
  cumulative_tokens: 'Cumulative session token usage when the prompt appeared',
  virtual_context_tokens: 'Tokens in the context window when the prompt appeared',
  tool_call_count: 'Main-agent tool calls observed since the session mount began',
  compaction_count: 'Compactions observed since the session mount began',
  permission_mode: 'Permission mode when the prompt appeared',
  thinking_effort: 'Thinking effort when the prompt appeared',
  subagent_count: 'Subagents in the session, excluding swarm members and session-init agents',
  subagent_models: 'Sorted comma-separated models used by subagents',
  swarm_run_count: 'AgentSwarm runs observed since the session mount began',
  swarm_models: 'Sorted comma-separated models used by swarm members',
  config_probability: 'Effective survey_popup probability when the prompt appeared',
  config_on_for_models: 'Effective survey_popup on_for_models, comma-separated',
  config_min_time_before_feedback_ms: 'Effective survey_popup min_time_before_feedback_ms',
  config_min_user_turns_before_feedback: 'Effective survey_popup min_user_turns_before_feedback',
  config_min_time_between_feedback_ms: 'Effective survey_popup min_time_between_feedback_ms',
  config_min_user_turns_between_feedback: 'Effective survey_popup min_user_turns_between_feedback',
  config_min_time_between_global_feedback_ms:
    'Effective survey_popup min_time_between_global_feedback_ms',
  config_long_context_survey_threshold: 'Effective survey_popup long_context_survey_threshold',
  config_long_context_probability: 'Effective survey_popup long_context_probability',
  config_long_context_trigger_mode: 'Effective survey_popup long_context_trigger_mode',
};

export const surveyEventDefinitions = {
  feedback_survey: defineTelemetryEvent<SurveyEventProperties>({
    owner: 'kimi-code',
    comment: 'A session rating prompt appears, is answered, or is abandoned.',
    properties: surveyEventPropertyDescriptions,
  }),
  long_context_survey: defineTelemetryEvent<SurveyEventProperties>({
    owner: 'kimi-code',
    comment: 'A long-context session rating prompt appears, is answered, or is abandoned.',
    properties: surveyEventPropertyDescriptions,
  }),
} as const;

export function buildSurveyEventProperties(
  core: SurveyEventCoreFields,
  environment: SurveyEventEnvironmentFields,
  config: SurveyPopupConfig,
): SurveyEventProperties {
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
