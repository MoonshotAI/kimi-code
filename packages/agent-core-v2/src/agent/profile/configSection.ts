/**
 * `profile` domain (L4) — `thinking` config-section env bindings.
 *
 * Declares the env-only `KIMI_MODEL_THINKING_EFFORT` force override. Applied
 * to the effective `thinking` value by `config` and stripped before
 * persistence.
 */

import { z } from 'zod';

import { type ConfigStripEnv, envBindings } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const THINKING_SECTION = 'thinking';

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  forcedEffort: z.string().optional(),
  keep: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

export const thinkingEnvBindings = envBindings(ThinkingConfigSchema, {
  forcedEffort: 'KIMI_MODEL_THINKING_EFFORT',
});

export const stripThinkingEnv: ConfigStripEnv<ThinkingConfig> = (value) => {
  const result = { ...value };
  delete result.forcedEffort;
  return result;
};

registerConfigSection(THINKING_SECTION, ThinkingConfigSchema, {
  env: thinkingEnvBindings,
  stripEnv: stripThinkingEnv,
});
