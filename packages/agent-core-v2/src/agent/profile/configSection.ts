/**
 * `profile` domain (L4) — `thinking` config-section env bindings and the
 * global `tools` tool-activation section.
 *
 * Declares the env-only `KIMI_MODEL_THINKING_EFFORT` force override. Applied
 * to the effective `thinking` value by `config` and stripped before
 * persistence.
 *
 * The `tools` section is the global tool switch: `enabled` is an allowlist
 * (when non-empty, only listed tools are active) and `disabled` a denylist,
 * applied on top of every profile's own `tools` / `disallowedTools` policy by
 * `IAgentToolPolicyService`.
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

export const TOOLS_SECTION = 'tools';

export const ToolsConfigSchema = z.object({
  enabled: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

registerConfigSection(TOOLS_SECTION, ToolsConfigSchema);
