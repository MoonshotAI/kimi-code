import { z } from 'zod';

import { parseNumberEnv } from '#/_base/utils/env';
import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { plainObjectToToml } from '#/app/config/toml';

export const LOOP_CONTROL_SECTION = 'loopControl';

export const LOOP_MAX_STEPS_PER_TURN_ENV = 'KIMI_LOOP_MAX_STEPS_PER_TURN';
export const LOOP_MAX_ATTEMPTS_PER_STEP_ENV = 'KIMI_LOOP_MAX_ATTEMPTS_PER_STEP';
export const LOOP_MAX_RETRIES_PER_STEP_ENV = 'KIMI_LOOP_MAX_RETRIES_PER_STEP';
export const LOOP_COMPACTION_TRIGGER_RATIO_ENV = 'KIMI_LOOP_COMPACTION_TRIGGER_RATIO';

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxAttemptsPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
  compactionMaxAttempts: z.number().int().min(1).optional(),
});

export type LoopControl = z.infer<typeof LoopControlSchema>;

function parseNonNegativeInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseCompactionTriggerRatio(raw: string): number | undefined {
  const parsed = parseNumberEnv(raw);
  return parsed !== undefined && parsed >= 0.5 && parsed <= 0.99 ? parsed : undefined;
}

export const loopControlEnvBindings: EnvBindings<LoopControl> = envBindings(LoopControlSchema, {
  maxStepsPerTurn: { env: LOOP_MAX_STEPS_PER_TURN_ENV, parse: parseNonNegativeInt },
  maxAttemptsPerStep: {
    env: LOOP_MAX_ATTEMPTS_PER_STEP_ENV,
    deprecatedEnv: LOOP_MAX_RETRIES_PER_STEP_ENV,
    parse: parseNonNegativeInt,
  },
  compactionTriggerRatio: {
    env: LOOP_COMPACTION_TRIGGER_RATIO_ENV,
    parse: parseCompactionTriggerRatio,
  },
});

export const stripLoopControlEnv = stripEnvBoundFields(loopControlEnvBindings);

export const loopControlToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return plainObjectToToml(value as Record<string, unknown>, rawSnake);
};

registerConfigSection(LOOP_CONTROL_SECTION, LoopControlSchema, {
  toToml: loopControlToToml,
  env: loopControlEnvBindings,
  stripEnv: stripLoopControlEnv,
  deprecations: [
    { key: 'max_retries_per_step', replacement: 'max_attempts_per_step' },
    { key: 'max_steps_per_run', replacement: 'max_steps_per_turn' },
  ],
});
