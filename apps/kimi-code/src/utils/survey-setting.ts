import type { KimiConfig, KimiConfigPatch } from '@moonshot-ai/kimi-code-sdk';

export interface SurveySettingMigrationDeps {
  readonly legacyValue: boolean | undefined;
  readonly getConfig: () => Promise<KimiConfig>;
  readonly setConfig: (patch: KimiConfigPatch) => Promise<unknown>;
  readonly dropLegacy: () => Promise<void>;
  readonly warn: (message: string) => void;
}

export type SurveySettingMigrationAction =
  | 'written'
  | 'kept_existing'
  | 'dropped_default'
  | 'write_failed';

export interface SurveySettingMigrationOutcome {
  readonly value: boolean | undefined;
  readonly configured: boolean | undefined;
  readonly action?: SurveySettingMigrationAction;
}

export async function migrateLegacySurveySetting(
  deps: SurveySettingMigrationDeps,
): Promise<SurveySettingMigrationOutcome> {
  const configured = (await deps.getConfig()).disableFeedbackSurvey;
  if (deps.legacyValue === undefined) return { value: configured, configured };
  let action: SurveySettingMigrationAction;
  if (configured !== undefined) {
    action = 'kept_existing';
  } else if (deps.legacyValue === false) {
    action = 'dropped_default';
  } else {
    try {
      await deps.setConfig({ disableFeedbackSurvey: deps.legacyValue });
      action = 'written';
    } catch {
      deps.warn(
        '[tui.toml] could not move disable_feedback_survey to config.toml; retrying on next start',
      );
      return { value: deps.legacyValue, configured, action: 'write_failed' };
    }
  }
  try {
    await deps.dropLegacy();
  } catch {
    deps.warn('[tui.toml] could not remove disable_feedback_survey; retrying on next start');
  }
  return { value: configured ?? deps.legacyValue, configured, action };
}
