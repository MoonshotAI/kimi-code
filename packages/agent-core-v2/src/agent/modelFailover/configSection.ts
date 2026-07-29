/**
 * `modelFailover` domain (L4) — runtime subagent model-failover preferences.
 *
 * Owns the `[subagent_failover]` configuration section: an ordered fallback
 * route, the failure classes that may advance it, and the per-turn switch
 * limit. `primary` resolves through the live default-model pointer;
 * `secondary` resolves through the existing secondary-model recipe; every
 * other value is a model alias. Self-registered at module load through
 * `config`.
 */

import { z } from 'zod';

import { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  DEFAULT_MODEL_SECTION,
  SECONDARY_MODEL_SECTION,
  type SecondaryModelConfig,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelPatch,
} from '#/app/kosongConfig/secondaryModelOverlay';

export const MODEL_FAILOVER_SECTION = 'subagentFailover';

export const ModelFailoverTriggerSchema = z.enum(['retry_exhausted', 'quota_exhausted']);

export type ModelFailoverTrigger = z.infer<typeof ModelFailoverTriggerSchema>;

export const ModelFailoverBindingSchema = z.object({
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
});

export type ModelFailoverBinding = z.infer<typeof ModelFailoverBindingSchema>;

export const ModelFailoverConfigSchema = z.object({
  fallbacks: z.array(ModelFailoverBindingSchema),
  on: z.array(ModelFailoverTriggerSchema).optional(),
  maxSwitchesPerTurn: z.number().int().min(0).optional(),
});

export type ModelFailoverConfig = z.infer<typeof ModelFailoverConfigSchema>;

export const DEFAULT_MODEL_FAILOVER_TRIGGERS: readonly ModelFailoverTrigger[] = [
  'retry_exhausted',
  'quota_exhausted',
];

export const DEFAULT_MAX_MODEL_SWITCHES_PER_TURN = 1;

registerConfigSection(MODEL_FAILOVER_SECTION, ModelFailoverConfigSchema, {
  defaultValue: {
    fallbacks: [],
    on: [...DEFAULT_MODEL_FAILOVER_TRIGGERS],
    maxSwitchesPerTurn: DEFAULT_MAX_MODEL_SWITCHES_PER_TURN,
  },
});

export interface ResolvedModelFailoverBinding {
  readonly model: string;
  readonly effort?: string;
}

export function resolveModelFailoverBinding(
  binding: ModelFailoverBinding,
  config: IConfigService,
): ResolvedModelFailoverBinding | undefined {
  const choice = binding.model.trim();
  if (choice === 'primary') {
    const model = config.get<string | undefined>(DEFAULT_MODEL_SECTION)?.trim();
    return model === undefined || model.length === 0
      ? undefined
      : { model, effort: binding.effort };
  }
  if (choice === 'secondary') {
    const secondary = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
    if (secondary === undefined) return undefined;
    const model = secondary.model?.trim();
    if (model === undefined || model.length === 0) return undefined;
    return {
      model: secondaryModelPatch(secondary) === undefined ? model : SECONDARY_DERIVED_MODEL_ID,
      effort: binding.effort ?? secondary.defaultEffort,
    };
  }
  return choice.length === 0 ? undefined : { model: choice, effort: binding.effort };
}
