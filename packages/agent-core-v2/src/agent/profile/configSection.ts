/**
 * `profile` domain (L4) — `thinking` config-section env bindings.
 *
 * Declares the `KIMI_MODEL_THINKING_EFFORT` environment binding (gated on
 * `KIMI_MODEL_NAME`). Applied to the effective `thinking` value by `config`.
 */

import { z } from 'zod';

import { envBindings } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const THINKING_SECTION = 'thinking';

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  keep: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

export const thinkingEnvBindings = envBindings(ThinkingConfigSchema, {
  effort: 'KIMI_MODEL_THINKING_EFFORT',
});

registerConfigSection(THINKING_SECTION, ThinkingConfigSchema, {
  env: thinkingEnvBindings,
});
