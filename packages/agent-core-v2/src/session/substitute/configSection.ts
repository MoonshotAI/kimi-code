import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { IFlagService } from '#/app/flag/flag';

import { SUBSTITUTE_MODEL_FLAG_ID } from './flag';

export const SUBSTITUTE_MODEL_SECTION = 'substituteModel';

export const SubstituteModelConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  cooldownMs: z.number().int().min(0).optional(),
});

export type SubstituteModelConfig = z.infer<typeof SubstituteModelConfigSchema>;

export const SUBSTITUTE_MODEL_ENV = 'KIMI_SUBSTITUTE_MODEL';
export const SUBSTITUTE_MODEL_COOLDOWN_ENV = 'KIMI_SUBSTITUTE_MODEL_COOLDOWN_MS';

export const DEFAULT_SUBSTITUTE_MODEL_COOLDOWN_MS = 5 * 60 * 1000;

function parseModelEnv(raw: string): string | undefined {
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

function parseCooldownEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const substituteModelEnvBindings: EnvBindings<SubstituteModelConfig> = envBindings(
  SubstituteModelConfigSchema,
  {
    defaultModel: { env: SUBSTITUTE_MODEL_ENV, parse: parseModelEnv },
    cooldownMs: { env: SUBSTITUTE_MODEL_COOLDOWN_ENV, parse: parseCooldownEnv },
  },
);

export const stripSubstituteModelEnv = stripEnvBoundFields(substituteModelEnvBindings);

registerConfigSection(SUBSTITUTE_MODEL_SECTION, SubstituteModelConfigSchema, {
  env: substituteModelEnvBindings,
  stripEnv: stripSubstituteModelEnv,
});

export function resolveSubstituteModel(
  config: IConfigService,
  flags: IFlagService,
): SubstituteModelConfig | undefined {
  if (!flags.enabled(SUBSTITUTE_MODEL_FLAG_ID)) return undefined;
  return config.get<SubstituteModelConfig | undefined>(SUBSTITUTE_MODEL_SECTION);
}

export function resolveSubstituteModelAlias(
  config: IConfigService,
  flags: IFlagService,
  overrides?: { substituteAlias?: string },
): string | undefined {
  if (overrides?.substituteAlias !== undefined) {
    return overrides.substituteAlias;
  }
  return resolveSubstituteModel(config, flags)?.defaultModel;
}

export function resolveSubstituteCooldownMs(
  config: IConfigService,
  flags: IFlagService,
): number {
  return (
    resolveSubstituteModel(config, flags)?.cooldownMs ?? DEFAULT_SUBSTITUTE_MODEL_COOLDOWN_MS
  );
}
