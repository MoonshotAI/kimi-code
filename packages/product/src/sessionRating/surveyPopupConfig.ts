export interface SurveyPopupConfig {
  probability: number;
  on_for_models: string[];
  min_time_before_feedback_ms: number;
  min_user_turns_before_feedback: number;
  min_time_between_feedback_ms: number;
  min_user_turns_between_feedback: number;
  min_time_between_global_feedback_ms: number;
  long_context_survey_threshold: number;
  long_context_probability: number;
  long_context_trigger_mode: 'cumulative' | 'virtual_context';
}

export const DEFAULT_SURVEY_POPUP_CONFIG: SurveyPopupConfig = {
  probability: 0.005,
  on_for_models: ['*'],
  min_time_before_feedback_ms: 600_000,
  min_user_turns_before_feedback: 5,
  min_time_between_feedback_ms: 3_600_000,
  min_user_turns_between_feedback: 10,
  min_time_between_global_feedback_ms: 100_000_000,
  long_context_survey_threshold: 200_000,
  long_context_probability: 0.2,
  long_context_trigger_mode: 'virtual_context',
};
