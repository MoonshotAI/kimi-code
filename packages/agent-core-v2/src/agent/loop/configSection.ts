import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { plainObjectToToml } from '#/app/config/toml';
import { MAX_TIMER_DELAY_MS } from '#/_base/utils/timer';

export const LOOP_CONTROL_SECTION = 'loopControl';

export const LOOP_MAX_STEPS_PER_TURN_ENV = 'KIMI_LOOP_MAX_STEPS_PER_TURN';
export const LOOP_MAX_ATTEMPTS_PER_STEP_ENV = 'KIMI_LOOP_MAX_ATTEMPTS_PER_STEP';
/** Deprecated former name of {@link LOOP_MAX_ATTEMPTS_PER_STEP_ENV}. */
export const LOOP_MAX_RETRIES_PER_STEP_ENV = 'KIMI_LOOP_MAX_RETRIES_PER_STEP';
export const LOOP_FIRST_OUTPUT_TIMEOUT_MS_ENV = 'KIMI_LOOP_FIRST_OUTPUT_TIMEOUT_MS';
export const LOOP_STREAM_IDLE_TIMEOUT_MS_ENV = 'KIMI_LOOP_STREAM_IDLE_TIMEOUT_MS';
export const LOOP_MAX_STALL_ATTEMPTS_PER_STEP_ENV = 'KIMI_LOOP_MAX_STALL_ATTEMPTS_PER_STEP';

export const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 180_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_STALL_ATTEMPTS_PER_STEP = 3;

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxAttemptsPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
  firstOutputTimeoutMs: z.number().int().min(0).max(MAX_TIMER_DELAY_MS).optional(),
  streamIdleTimeoutMs: z.number().int().min(0).max(MAX_TIMER_DELAY_MS).optional(),
  maxStallAttemptsPerStep: z.number().int().min(0).optional(),
});

export type LoopControl = z.infer<typeof LoopControlSchema>;

function parseNonNegativeInt(raw: string, max?: number): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && (max === undefined || parsed <= max)
    ? parsed
    : undefined;
}

const parseTimerDelayMs = (raw: string): number | undefined =>
  parseNonNegativeInt(raw, MAX_TIMER_DELAY_MS);

export const loopControlEnvBindings: EnvBindings<LoopControl> = envBindings(LoopControlSchema, {
  maxStepsPerTurn: { env: LOOP_MAX_STEPS_PER_TURN_ENV, parse: parseNonNegativeInt },
  maxAttemptsPerStep: {
    env: LOOP_MAX_ATTEMPTS_PER_STEP_ENV,
    deprecatedEnv: LOOP_MAX_RETRIES_PER_STEP_ENV,
    parse: parseNonNegativeInt,
  },
  firstOutputTimeoutMs: { env: LOOP_FIRST_OUTPUT_TIMEOUT_MS_ENV, parse: parseTimerDelayMs },
  streamIdleTimeoutMs: { env: LOOP_STREAM_IDLE_TIMEOUT_MS_ENV, parse: parseTimerDelayMs },
  maxStallAttemptsPerStep: {
    env: LOOP_MAX_STALL_ATTEMPTS_PER_STEP_ENV,
    parse: parseNonNegativeInt,
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
