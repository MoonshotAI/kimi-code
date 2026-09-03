import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import {
  FALLBACK_MODEL_SECTION,
  type FallbackModelConfig,
} from '#/app/kosongConfig/configSection';

import { FALLBACK_MODEL_FLAG_ID } from './flag';

export { FALLBACK_MODEL_FLAG_ID };

export function resolveFallbackModel(
  config: IConfigService,
  flags: IFlagService,
  overrides?: { fallbackAlias?: string },
): FallbackModelConfig | undefined {
  if (overrides?.fallbackAlias !== undefined) {
    return { model: overrides.fallbackAlias } as FallbackModelConfig;
  }
  if (!flags.enabled(FALLBACK_MODEL_FLAG_ID)) return undefined;
  return config.get<FallbackModelConfig | undefined>(FALLBACK_MODEL_SECTION);
}

export function resolveFallbackSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
  overrides?: { fallbackSecondaryAlias?: string },
): string | undefined {
  if (overrides?.fallbackSecondaryAlias !== undefined) {
    return overrides.fallbackSecondaryAlias;
  }
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
  overrides?: { fallbackAlias?: string; fallbackSecondaryAlias?: string },
): FallbackBinding | undefined {
  if (overrides?.fallbackAlias !== undefined) {
    return {
      model: overrides.fallbackAlias,
      thinking: own.thinkingLevel,
      displayModel: overrides.fallbackAlias,
    };
  }
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
