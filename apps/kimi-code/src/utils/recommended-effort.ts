import { isManagedKimiCodeBaseUrl } from '@moonshot-ai/kimi-code-oauth';
import type { KimiConfig, KimiConfigPatch, ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { TelemetryProperties } from '@moonshot-ai/kimi-telemetry';

import { getRecommendedEffortStateFile } from '#/utils/paths';
import type { RecommendedEffortConfig } from '#/utils/recommended-effort-config';
import {
  readRecommendedEffortState,
  writeRecommendedEffortState,
} from '#/utils/recommended-effort-state-store';

export interface ApplyRecommendedEffortDeps {
  fetchConfig: () => Promise<RecommendedEffortConfig | undefined>;
  getConfig: () => Promise<KimiConfig>;
  setConfig: (patch: KimiConfigPatch) => Promise<unknown>;
  track: (event: string, properties?: TelemetryProperties) => void;
  stateFile?: string;
  now?: () => Date;
}

function eligibleModelEntry(config: KimiConfig): ModelAlias | undefined {
  if (config.thinking?.enabled === false) return undefined;
  const alias = config.defaultModel;
  if (alias === undefined) return undefined;
  const entry = config.models?.[alias];
  if (entry === undefined) return undefined;
  const baseUrl = entry.baseUrl ?? config.providers[entry.provider]?.baseUrl;
  return isManagedKimiCodeBaseUrl(baseUrl) ? entry : undefined;
}

export async function applyRecommendedEffort(deps: ApplyRecommendedEffortDeps): Promise<void> {
  try {
    if (eligibleModelEntry(await deps.getConfig()) === undefined) return;
    const cloud = await deps.fetchConfig();
    if (cloud === undefined) return;

    const config = await deps.getConfig();
    const modelEntry = eligibleModelEntry(config);
    if (modelEntry === undefined) return;
    const campaign = cloud[modelEntry.model];
    if (campaign === undefined) return;
    const supportEfforts = modelEntry.overrides?.supportEfforts ?? modelEntry.supportEfforts;
    if (!supportEfforts?.includes(campaign.recommended_default_effort)) return;

    const stateFile = deps.stateFile ?? getRecommendedEffortStateFile();
    const state = await readRecommendedEffortState(stateFile);
    const applied = state[modelEntry.model];
    if (applied !== undefined && campaign.version <= applied.version) return;

    const previousEffort = config.thinking?.effort;
    if (previousEffort !== campaign.recommended_default_effort) {
      await deps.setConfig({ thinking: { effort: campaign.recommended_default_effort } });
    }
    writeRecommendedEffortState(
      {
        ...state,
        [modelEntry.model]: {
          version: campaign.version,
          applied_at: (deps.now?.() ?? new Date()).toISOString(),
        },
      },
      stateFile,
    );
    deps.track('recommended_effort_applied', {
      model: modelEntry.model,
      version: campaign.version,
      effort: campaign.recommended_default_effort,
      previous_effort: previousEffort,
    });
  } catch {
  }
}
