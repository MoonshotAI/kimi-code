/**
 * `task` domain (L5) — task config-section schema and env bindings.
 *
 * Owns the `[task]` configuration section (task limits and lifecycle tuning).
 * The legacy `[background]` section is registered with the same schema so old
 * configs continue to load while callers migrate; effective values use legacy
 * fields as the base and let `[task]` override matching fields.
 * `keepAliveOnExit` also
 * accepts the v1 env override `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT`
 * (applied live by the config env overlay, never persisted). Also owns the
 * `kimi -p` print-mode background policy (`printBackgroundMode` /
 * `printWaitCeilingS` / `printMaxTurns`), resolved with v1 semantics by
 * `resolvePrintBackgroundMode`. Self-registered
 * at module load via `registerConfigSection`, so the `config` domain never
 * imports this domain's types.
 */

import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import { type EnvBindings, envBindings, type IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const TASK_SECTION = 'task';
export const LEGACY_BACKGROUND_SECTION = 'background';

export const PrintBackgroundModeSchema = z.enum(['exit', 'drain', 'steer']);

export type PrintBackgroundMode = z.infer<typeof PrintBackgroundModeSchema>;

export const AgentTaskConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
  printBackgroundMode: PrintBackgroundModeSchema.optional(),
  printMaxTurns: z.number().int().min(1).optional(),
});

export type AgentTaskConfig = z.infer<typeof AgentTaskConfigSchema>;

export function resolveAgentTaskConfig(config: IConfigService): AgentTaskConfig | undefined {
  const legacy = config.get<AgentTaskConfig | undefined>(LEGACY_BACKGROUND_SECTION);
  const current = config.get<AgentTaskConfig | undefined>(TASK_SECTION);
  if (legacy === undefined) return current;
  if (current === undefined) return legacy;
  return { ...legacy, ...current };
}

/**
 * Resolve the effective print-mode (`kimi -p`) background-task policy, mirroring
 * v1's `Session.resolvePrintBackgroundMode`: `printBackgroundMode` is
 * authoritative when set; otherwise fall back to the legacy `keepAliveOnExit`
 * mapping (`true` ⇒ `'drain'`, otherwise `'exit'`). The
 * `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` env override is applied by the
 * config env overlay (see `taskEnvBindings`), so it is covered here.
 */
export function resolvePrintBackgroundMode(config: IConfigService): PrintBackgroundMode {
  const section = resolveAgentTaskConfig(config);
  if (section?.printBackgroundMode !== undefined) return section.printBackgroundMode;
  return section?.keepAliveOnExit === true ? 'drain' : 'exit';
}

export const KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';

export const taskEnvBindings: EnvBindings<AgentTaskConfig> = envBindings(AgentTaskConfigSchema, {
  keepAliveOnExit: { env: KEEP_ALIVE_ON_EXIT_ENV, parse: parseBooleanEnv },
});

registerConfigSection(TASK_SECTION, AgentTaskConfigSchema, { env: taskEnvBindings });
registerConfigSection(LEGACY_BACKGROUND_SECTION, AgentTaskConfigSchema, { env: taskEnvBindings });
