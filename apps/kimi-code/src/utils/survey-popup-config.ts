import { z } from 'zod';

import {
  getClientConfig,
  peekClientConfig,
  resetClientConfigCache,
  type ClientConfigFetchOptions,
} from '#/utils/client-configs';

const CONFIG_NAME = 'survey_popup';

/** The `survey_popup` wire shape; every layer below (process cache, disk
 *  cache, network failure, per-field parse failure) falls back to the
 *  built-in defaults. */
export interface SurveyPopupConfig {
  probability: number;
  /** Model gate: exact match, `"*"` opens for every model, `[]` closes both arms. */
  on_for_models: string[];
  min_time_before_feedback_ms: number;
  min_user_turns_before_feedback: number;
  min_time_between_feedback_ms: number;
  min_user_turns_between_feedback: number;
  /** Cross-session cooldown, persisted as `last_shown_time`. */
  min_time_between_global_feedback_ms: number;
  /** Token threshold for the long-context arm; invalid/non-positive disables that arm. */
  long_context_survey_threshold: number;
  long_context_probability: number;
  /** Which token counter the threshold compares against. */
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
  long_context_trigger_mode: 'cumulative',
};

const FIELD_SCHEMAS = {
  probability: z.number().min(0).max(1),
  on_for_models: z.array(z.string()),
  min_time_before_feedback_ms: z.number().min(0),
  min_user_turns_before_feedback: z.number().int().min(0),
  min_time_between_feedback_ms: z.number().min(0),
  min_user_turns_between_feedback: z.number().int().min(0),
  min_time_between_global_feedback_ms: z.number().min(0),
  long_context_survey_threshold: z.number(),
  long_context_probability: z.number().min(0).max(1),
  long_context_trigger_mode: z.enum(['cumulative', 'virtual_context']),
} satisfies Record<keyof SurveyPopupConfig, z.ZodType>;

const surveyPopupConfigSchema = z.unknown().transform((raw): Partial<SurveyPopupConfig> => {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const partial: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(FIELD_SCHEMAS)) {
    const value = record[key];
    if (value === undefined) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success) partial[key] = parsed.data;
  }
  return partial as Partial<SurveyPopupConfig>;
});

function withDefaults(partial: Partial<SurveyPopupConfig> | undefined): SurveyPopupConfig {
  return { ...DEFAULT_SURVEY_POPUP_CONFIG, ...partial };
}

export async function getSurveyPopupConfig(
  options: ClientConfigFetchOptions = {},
): Promise<SurveyPopupConfig> {
  return withDefaults(await getClientConfig(CONFIG_NAME, surveyPopupConfigSchema, options));
}

export function peekSurveyPopupConfig(now?: number): SurveyPopupConfig {
  return withDefaults(peekClientConfig(CONFIG_NAME, surveyPopupConfigSchema, now));
}

export function peekSurveyPopupConfigFresh(now?: number): boolean {
  return peekClientConfig(CONFIG_NAME, surveyPopupConfigSchema, now) !== undefined;
}

export function resetSurveyPopupConfigCache(): void {
  resetClientConfigCache(CONFIG_NAME);
}
