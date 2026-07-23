/**
 * `kosong/model` domain (L2) — the secondary-model config section.
 *
 * The secondary model is a consumer-neutral pointer to a second model (any
 * configured alias, typically a cheaper one) next to the primary
 * `default_model`. Features that want a non-primary model resolve it from
 * here instead of growing per-feature config keys. The first consumer is
 * subagent spawning (`session/subagent` + `agent/swarm`): when configured,
 * newly spawned subagents bind to it by default instead of inheriting the
 * caller's model, and the spawning tools let the parent model opt back into
 * the primary model per spawn.
 *
 * Owns the `secondaryModel` section (`model` / `effort` on disk) together with
 * the `KIMI_SECONDARY_MODEL` / `KIMI_SECONDARY_EFFORT` env overrides. While an
 * env var is set, `stripEnvBoundFields` restores the env-free raw value before
 * persistence, so the override never leaks into `config.toml`. Self-registered
 * at module load via `registerConfigSection`, so the `config` domain never
 * imports this domain's types.
 *
 * Note: the `app/config` imports below are deliberately RELATIVE paths — see
 * `modelService.ts` for the rationale.
 */

import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  type IConfigService,
  stripEnvBoundFields,
} from '../../app/config/config';
import { registerConfigSection } from '../../app/config/configSectionContributions';

export const SECONDARY_MODEL_SECTION = 'secondaryModel';

export const SECONDARY_MODEL_ENV = 'KIMI_SECONDARY_MODEL';
export const SECONDARY_MODEL_EFFORT_ENV = 'KIMI_SECONDARY_EFFORT';

export const SecondaryModelConfigSchema = z.object({
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

function parseNonEmptyEnv(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const secondaryModelEnvBindings: EnvBindings<SecondaryModelConfig> = envBindings(
  SecondaryModelConfigSchema,
  {
    model: { env: SECONDARY_MODEL_ENV, parse: parseNonEmptyEnv },
    effort: { env: SECONDARY_MODEL_EFFORT_ENV, parse: parseNonEmptyEnv },
  },
);

registerConfigSection(SECONDARY_MODEL_SECTION, SecondaryModelConfigSchema, {
  env: secondaryModelEnvBindings,
  stripEnv: stripEnvBoundFields(secondaryModelEnvBindings),
});

/**
 * Resolve the configured secondary-model pair (`undefined` when unset).
 * Consumers decide individually what binding the pair implies for them.
 */
export function resolveSecondaryModel(
  config: IConfigService,
): SecondaryModelConfig | undefined {
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
}
