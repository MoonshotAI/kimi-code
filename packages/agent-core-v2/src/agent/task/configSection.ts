/**
 * `task` domain (L5) — task config-section schema.
 *
 * Owns the `[task]` configuration section (task limits and lifecycle tuning).
 * The legacy `[background]` section is registered with the same schema so old
 * configs continue to load while callers migrate. Self-registered at module
 * load via `registerConfigSection`, so the `config` domain never imports this
 * domain's types.
 */

import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
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

/**
 * Read the effective task config, falling back to the legacy `[background]`
 * section when `[task]` is unset.
 */
export function resolveAgentTaskConfig(config: IConfigService): AgentTaskConfig | undefined {
  return (
    config.get<AgentTaskConfig | undefined>(TASK_SECTION) ??
    config.get<AgentTaskConfig | undefined>(LEGACY_BACKGROUND_SECTION)
  );
}

registerConfigSection(TASK_SECTION, AgentTaskConfigSchema);
registerConfigSection(LEGACY_BACKGROUND_SECTION, AgentTaskConfigSchema);
