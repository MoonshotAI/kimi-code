import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import {
  FALLBACK_MODEL_SECTION,
  type FallbackModelConfig,
} from '#/app/kosongConfig/configSection';

import { FALLBACK_MODEL_FLAG_ID } from './flag';

export { FALLBACK_MODEL_FLAG_ID };

/**
 * `fallback` domain — fallback-model config-section resolver.
 *
 * Mirror of the compaction-model resolver: when the `fallback-model`
 * experiment is enabled and `[fallback_model]` is configured, the agent loop
 * transparently retries on the configured alias after the primary model
 * exhausts its retry budget. The dedicated cascade is opt-in: when the flag is
 * off or `[fallback_model]` is unset, returns `undefined` from
 * {@link resolveFallbackModel} — the loop's existing terminal-error behavior
 * is unchanged.
 */
export function resolveFallbackModel(
  config: IConfigService,
  flags: IFlagService,
): FallbackModelConfig | undefined {
  if (!flags.enabled(FALLBACK_MODEL_FLAG_ID)) return undefined;
  return config.get<FallbackModelConfig | undefined>(FALLBACK_MODEL_SECTION);
}

export function resolveFallbackSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
): string | undefined {
  return resolveFallbackModel(config, flags)?.secondaryModel;
}

export interface FallbackBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
}

export function resolveFallbackBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  lastTriedAlias?: string,
): FallbackBinding | undefined {
  const fallback = resolveFallbackModel(config, flags);
  if (fallback === undefined) return undefined;
  if (fallback.model !== undefined && fallback.model !== lastTriedAlias) {
    return {
      model: fallback.model,
      thinking: own.thinkingLevel,
      displayModel: fallback.model,
    };
  }
  if (fallback.secondaryModel !== undefined && fallback.secondaryModel !== lastTriedAlias) {
    return {
      model: fallback.secondaryModel,
      thinking: own.thinkingLevel,
      displayModel: fallback.secondaryModel,
    };
  }
  return undefined;
}
