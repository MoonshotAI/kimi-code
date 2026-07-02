/**
 * `profile` domain (L4) — `thinking` / `defaultThinking` config-section env bindings.
 *
 * Declares the `KIMI_MODEL_THINKING_MODE` / `KIMI_MODEL_THINKING_EFFORT` /
 * `KIMI_MODEL_DEFAULT_THINKING` environment bindings (gated on
 * `KIMI_MODEL_NAME`). Applied to the effective `thinking` / `defaultThinking`
 * values by `config`.
 */

import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils';
import { type EnvBindings, envBindings } from '#/app/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const THINKING_SECTION = 'thinking';
export const DEFAULT_THINKING_SECTION = 'defaultThinking';

export const ThinkingConfigSchema = z.object({
  mode: z.enum(['auto', 'on', 'off']).optional(),
  effort: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

function parseBooleanVar(raw: string): boolean {
  const parsed = parseBooleanEnv(raw);
  if (parsed === undefined) {
    throw new Error(`KIMI_MODEL_DEFAULT_THINKING must be a boolean, got "${raw}".`);
  }
  return parsed;
}

export const thinkingEnvBindings = envBindings(ThinkingConfigSchema, {
  mode: 'KIMI_MODEL_THINKING_MODE',
  effort: 'KIMI_MODEL_THINKING_EFFORT',
});

export const defaultThinkingEnvBindings: EnvBindings<boolean> = {
  env: 'KIMI_MODEL_DEFAULT_THINKING',
  parse: parseBooleanVar,
};

registerConfigSection(THINKING_SECTION, ThinkingConfigSchema, {
  env: thinkingEnvBindings,
});
registerConfigSection(DEFAULT_THINKING_SECTION, { parse: (v) => v as boolean }, {
  env: defaultThinkingEnvBindings,
});
