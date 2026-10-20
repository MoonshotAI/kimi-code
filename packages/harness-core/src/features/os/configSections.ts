import { z } from 'zod';

import {
  isEnvBinding,
  isPlainObject,
  type ConfigSectionContribution,
  type ConfigStore,
  type EnvBinding,
  type EnvBindings,
  type GetEnv,
} from '#/features/config/index';

const TRUE_BOOLEAN_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

export function stripEnvBoundFields<T>(
  bindings: EnvBindings<T>,
): (value: T, raw: unknown, getEnv: GetEnv) => T | undefined {
  return (value, raw, getEnv) => {
    if (value === null || typeof value !== 'object') return value;
    if (!isPlainObject(bindings) || isEnvBinding(bindings)) return value;
    const base = isPlainObject(raw) ? raw : {};
    let out: Record<string, unknown> | undefined;
    for (const [field, binding] of Object.entries(bindings)) {
      if (binding === undefined || !isEnvBinding(binding)) continue;
      if (!resolvesFromEnv(binding, getEnv)) continue;
      out ??= { ...(value as Record<string, unknown>) };
      if (base[field] !== undefined) {
        out[field] = base[field];
      } else {
        delete out[field];
      }
    }
    if (out === undefined) return value;
    if (Object.keys(out).length > 0) return out as T;
    return (Object.keys(base).length > 0 ? base : undefined) as T | undefined;
  };
}

function resolvesFromEnv(binding: EnvBinding, getEnv: GetEnv): boolean {
  const parse = typeof binding === 'string' ? undefined : binding.parse;
  const names =
    typeof binding === 'string'
      ? [binding]
      : binding.deprecatedEnv === undefined
        ? [binding.env]
        : [binding.env, binding.deprecatedEnv];
  return names.some((name) => {
    const raw = getEnv(name);
    return raw !== undefined && (parse === undefined || parse(raw) !== undefined);
  });
}

export const READ_CONFIG_SECTION = 'read';

export const ReadSectionSchema = z.object({
  defaultMaxChars: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
});

export type ReadSection = z.infer<typeof ReadSectionSchema>;

export const readConfigSection: ConfigSectionContribution<ReadSection> = {
  name: READ_CONFIG_SECTION,
  schema: ReadSectionSchema,
  defaultValue: {},
};

export const TASK_CONFIG_SECTION = 'task';

export const LEGACY_BACKGROUND_CONFIG_SECTION = 'background';

export const PrintBackgroundModeSchema = z.enum(['exit', 'drain', 'steer']);

export type PrintBackgroundMode = z.infer<typeof PrintBackgroundModeSchema>;

export const TaskSectionSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  bashTaskTimeoutS: z.number().int().min(0).optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
  printBackgroundMode: PrintBackgroundModeSchema.optional(),
  printMaxTurns: z.number().int().min(1).optional(),
});

export type TaskSection = z.infer<typeof TaskSectionSchema>;

export const KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';
export const MAX_RUNNING_TASKS_ENV = 'KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS';
export const BASH_TASK_TIMEOUT_S_ENV = 'KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S';
export const PRINT_WAIT_CEILING_S_ENV = 'KIMI_CODE_BACKGROUND_PRINT_WAIT_CEILING_S';
export const PRINT_BACKGROUND_MODE_ENV = 'KIMI_CODE_BACKGROUND_PRINT_BACKGROUND_MODE';
export const PRINT_MAX_TURNS_ENV = 'KIMI_CODE_BACKGROUND_PRINT_MAX_TURNS';

function parsePositiveInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePrintBackgroundMode(raw: string): PrintBackgroundMode | undefined {
  const parsed = PrintBackgroundModeSchema.safeParse(raw.trim());
  return parsed.success ? parsed.data : undefined;
}

const taskEnvBindings: EnvBindings<TaskSection> = {
  keepAliveOnExit: { env: KEEP_ALIVE_ON_EXIT_ENV, parse: parseBooleanEnv },
  maxRunningTasks: { env: MAX_RUNNING_TASKS_ENV, parse: parsePositiveInt },
  bashTaskTimeoutS: { env: BASH_TASK_TIMEOUT_S_ENV, parse: parseNonNegativeInt },
  printWaitCeilingS: { env: PRINT_WAIT_CEILING_S_ENV, parse: parsePositiveInt },
  printBackgroundMode: { env: PRINT_BACKGROUND_MODE_ENV, parse: parsePrintBackgroundMode },
  printMaxTurns: { env: PRINT_MAX_TURNS_ENV, parse: parsePositiveInt },
};

export const taskConfigSection: ConfigSectionContribution<TaskSection> = {
  name: TASK_CONFIG_SECTION,
  schema: TaskSectionSchema,
  envBindings: taskEnvBindings,
  stripEnv: stripEnvBoundFields<TaskSection>(taskEnvBindings),
};

export const legacyBackgroundConfigSection: ConfigSectionContribution<TaskSection> = {
  name: LEGACY_BACKGROUND_CONFIG_SECTION,
  schema: TaskSectionSchema,
  envBindings: taskEnvBindings,
  stripEnv: stripEnvBoundFields<TaskSection>(taskEnvBindings),
};

export function resolveAgentTaskConfig(
  config: Pick<ConfigStore, 'get'>,
): TaskSection | undefined {
  const legacy = config.get<TaskSection | undefined>(LEGACY_BACKGROUND_CONFIG_SECTION);
  const current = config.get<TaskSection | undefined>(TASK_CONFIG_SECTION);
  if (legacy === undefined) return current;
  if (current === undefined) return legacy;
  return { ...legacy, ...current };
}

export function resolvePrintBackgroundMode(config: Pick<ConfigStore, 'get'>): PrintBackgroundMode {
  const section = resolveAgentTaskConfig(config);
  if (section?.printBackgroundMode !== undefined) return section.printBackgroundMode;
  return section?.keepAliveOnExit === true ? 'drain' : 'steer';
}
