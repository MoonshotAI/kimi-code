/**
 * `task` domain (L5) — task config-section schema and env bindings.
 *
 * Owns the `[task]` configuration section (task limits and lifecycle tuning).
 * The legacy `[background]` section is registered with the same schema so old
 * configs continue to load while callers migrate; effective values use legacy
 * fields as the base and let `[task]` override matching fields.
 * `keepAliveOnExit` also
 * accepts the v1 env override `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT`
 * (applied live by the config env overlay, never persisted). Self-registered
 * at module load via `registerConfigSection`, so the `config` domain never
 * imports this domain's types.
 */

import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import { type EnvBindings, envBindings, type IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const TASK_SECTION = 'task';
export const LEGACY_BACKGROUND_SECTION = 'background';

export const AgentTaskConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  /**
   * When a foreground Bash command times out, move it to the background
   * instead of killing it. Defaults to true when unset.
   */
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
});

export type AgentTaskConfig = z.infer<typeof AgentTaskConfigSchema>;

export function resolveAgentTaskConfig(config: IConfigService): AgentTaskConfig | undefined {
  const legacy = config.get<AgentTaskConfig | undefined>(LEGACY_BACKGROUND_SECTION);
  const current = config.get<AgentTaskConfig | undefined>(TASK_SECTION);
  if (legacy === undefined) return current;
  if (current === undefined) return legacy;
  return { ...legacy, ...current };
}

export const KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';

export const taskEnvBindings: EnvBindings<AgentTaskConfig> = envBindings(AgentTaskConfigSchema, {
  keepAliveOnExit: { env: KEEP_ALIVE_ON_EXIT_ENV, parse: parseBooleanEnv },
});

registerConfigSection(TASK_SECTION, AgentTaskConfigSchema, { env: taskEnvBindings });
registerConfigSection(LEGACY_BACKGROUND_SECTION, AgentTaskConfigSchema, { env: taskEnvBindings });
