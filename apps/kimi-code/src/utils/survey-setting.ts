import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  type KimiConfig,
  type KimiConfigPatch,
} from '@moonshot-ai/kimi-code-sdk';

export function configuredSurveyOptOut(): boolean | undefined {
  return loadRuntimeConfigSafe(resolveConfigPath({})).config.disableFeedbackSurvey;
}

export interface SurveySettingMigrationDeps {
  readonly legacyValue: boolean | undefined;
  readonly getConfig: () => Promise<KimiConfig>;
  readonly setConfig: (patch: KimiConfigPatch) => Promise<unknown>;
  readonly dropLegacy: () => Promise<void>;
  readonly warn: (message: string) => void;
}

export async function migrateLegacySurveySetting(
  deps: SurveySettingMigrationDeps,
): Promise<boolean | undefined> {
  const configured = (await deps.getConfig()).disableFeedbackSurvey;
  if (deps.legacyValue === undefined) return configured;
  if (configured === undefined) {
    try {
      await deps.setConfig({ disableFeedbackSurvey: deps.legacyValue });
    } catch {
      deps.warn(
        '[tui.toml] could not move disable_feedback_survey to config.toml; retrying on next start',
      );
      return deps.legacyValue;
    }
  }
  try {
    await deps.dropLegacy();
  } catch {
    deps.warn('[tui.toml] could not remove disable_feedback_survey after moving it to config.toml');
  }
  return configured ?? deps.legacyValue;
}
