import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import {
  COMPACTION_MODEL_ENV,
  COMPACTION_MODEL_SECTION,
  type CompactionModelConfig,
} from '#/app/kosongConfig/configSection';
import {
  COMPACTION_DERIVED_MODEL_ID,
  compactionModelPatch,
} from '#/app/kosongConfig/compactionModelOverlay';

import { COMPACTION_MODEL_FLAG_ID } from './flag';

export { COMPACTION_DERIVED_MODEL_ID };

export interface CompactionBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
}

export function resolveCompactionModel(
  config: IConfigService,
  flags: IFlagService,
  overrides?: { compactionAlias?: string },
): CompactionModelConfig | undefined {
  if (overrides?.compactionAlias !== undefined) {
    return { model: overrides.compactionAlias } as CompactionModelConfig;
  }
  if (!flags.enabled(COMPACTION_MODEL_FLAG_ID)) return undefined;
  return config.get<CompactionModelConfig | undefined>(COMPACTION_MODEL_SECTION);
}

export function resolveCompactionSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
  overrides?: { compactionSecondaryAlias?: string },
): string | undefined {
  if (overrides?.compactionSecondaryAlias !== undefined) {
    return overrides.compactionSecondaryAlias;
  }
  return resolveCompactionModel(config, flags)?.secondaryModel;
}

export function resolveCompactionBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  overrides?: { compactionAlias?: string },
): CompactionBinding {
  const overrideAlias = overrides?.compactionAlias;
  if (overrideAlias !== undefined) {
    return {
      model: overrideAlias,
      displayModel: compactionDisplayModel(config, overrideAlias),
    };
  }
  const compaction = resolveCompactionModel(config, flags);
  const pointer = compaction?.model ?? compaction?.defaultModel;
  if (compaction !== undefined && pointer !== undefined) {
    const model =
      compactionModelPatch(compaction) === undefined
        ? pointer
        : COMPACTION_DERIVED_MODEL_ID;
    return {
      model,
      thinking: compaction.defaultEffort,
      displayModel: compactionDisplayModel(config, model),
    };
  }
  return {
    model: own.modelAlias,
    thinking: own.thinkingLevel,
    displayModel: compactionDisplayModel(config, own.modelAlias),
  };
}

export function compactionModelBindingFor(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  overrides?: { compactionAlias?: string },
): CompactionBinding {
  return resolveCompactionBinding(config, flags, own, overrides);
}

export function compactionDisplayModel(config: IConfigService, boundAlias: string): string {
  if (boundAlias !== COMPACTION_DERIVED_MODEL_ID) return boundAlias;
  return (
    config.get<CompactionModelConfig | undefined>(COMPACTION_MODEL_SECTION)?.model ?? boundAlias
  );
}

export function wrapCompactionModelError(error: unknown, boundModel: string): unknown {
  if (boundModel === COMPACTION_DERIVED_MODEL_ID) {
    return new Error(
      `Compaction model "${boundModel}" from [compaction_model] / ${COMPACTION_MODEL_ENV} is not a valid [models] entry`,
      { cause: error },
    );
  }
  return error;
}
