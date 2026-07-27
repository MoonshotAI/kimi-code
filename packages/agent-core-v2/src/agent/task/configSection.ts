/**
 * `task` domain (L5) — task config-section schema and env bindings.
 *
 * Owns the `[task]` configuration section (task limits and lifecycle tuning).
 * The legacy `[background]` section is registered with the same schema so old
 * configs continue to load while callers migrate; effective values use legacy
 * fields as the base and let `[task]` override matching fields.
 * `keepAliveOnExit` and `maxRunningTasks` also
 * accept the v1 env overrides `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` /
 * `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS`
 * (applied live by the config env overlay; while a field's env var is set,
 * `stripEnvBoundFields` restores its env-free raw value before persistence, so
 * env values never leak into `config.toml`). Also owns the
 * `kimi -p` print-mode background policy (`printBackgroundMode` /
 * `printWaitCeilingS` / `printMaxTurns`), resolved with v1 semantics by
 * `resolvePrintBackgroundMode`. Self-registered
 * at module load via `registerConfigSection`, so the `config` domain never
 * imports this domain's types.
 */

import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const TASK_SECTION = 'task';
export const LEGACY_BACKGROUND_SECTION = 'background';

export const PrintBackgroundModeSchema = z.enum(['exit', 'drain', 'steer']);

export type PrintBackgroundMode = z.infer<typeof PrintBackgroundModeSchema>;

export const AgentTaskConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  bashTaskTimeoutS: z.number().int().min(0).optional(),
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

export function resolvePrintBackgroundMode(config: IConfigService): PrintBackgroundMode {
  const section = resolveAgentTaskConfig(config);
  if (section?.printBackgroundMode !== undefined) return section.printBackgroundMode;
  return section?.keepAliveOnExit === true ? 'drain' : 'steer';
}

export const KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';
export const MAX_RUNNING_TASKS_ENV = 'KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS';

function parsePositiveInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export const taskEnvBindings: EnvBindings<AgentTaskConfig> = envBindings(AgentTaskConfigSchema, {
  keepAliveOnExit: { env: KEEP_ALIVE_ON_EXIT_ENV, parse: parseBooleanEnv },
  maxRunningTasks: { env: MAX_RUNNING_TASKS_ENV, parse: parsePositiveInt },
});

export const stripTaskEnv = stripEnvBoundFields(taskEnvBindings);

registerConfigSection(TASK_SECTION, AgentTaskConfigSchema, {
  env: taskEnvBindings,
  stripEnv: stripTaskEnv,
});
registerConfigSection(LEGACY_BACKGROUND_SECTION, AgentTaskConfigSchema, {
  env: taskEnvBindings,
  stripEnv: stripTaskEnv,
});
