/**
 * `loop` domain — `loopControl` config-section schema, env bindings, and
 * TOML transforms.
 *
 * Owns the `[loop_control]` configuration section (step / retry / context-size
 * limits). Renamed keys are declared through the config domain's deprecation
 * mechanism (`deprecations`): a deprecated key in `config.toml` no longer
 * applies and reports a warning pointing at its replacement — this covers the
 * `max_retries_per_step` → `max_attempts_per_step` rename and the older
 * `max_steps_per_run` → `max_steps_per_turn` one. The step and retry budgets
 * also accept operational env overrides (`KIMI_LOOP_MAX_STEPS_PER_TURN` /
 * `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP`; the former
 * `KIMI_LOOP_MAX_RETRIES_PER_STEP` still resolves as a deprecated fallback
 * with a warning); `config` resolves each field as `env > config.toml >
 * default` and re-applies the env binding on every read. Self-registered at
 * module load via `registerConfigSection`.
 *
 * While a field's env var is set, `stripEnvBoundFields` restores its env-free
 * raw value before `set`/`replace` persists, so an env override echoed
 * back through a config write can never leak into `config.toml`.
 */

import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { plainObjectToToml } from '#/app/config/toml';

export const LOOP_CONTROL_SECTION = 'loopControl';

export const LOOP_MAX_STEPS_PER_TURN_ENV = 'KIMI_LOOP_MAX_STEPS_PER_TURN';
export const LOOP_MAX_ATTEMPTS_PER_STEP_ENV = 'KIMI_LOOP_MAX_ATTEMPTS_PER_STEP';
/** Deprecated former name of {@link LOOP_MAX_ATTEMPTS_PER_STEP_ENV}. */
export const LOOP_MAX_RETRIES_PER_STEP_ENV = 'KIMI_LOOP_MAX_RETRIES_PER_STEP';

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxAttemptsPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
});

export type LoopControl = z.infer<typeof LoopControlSchema>;

function parseNonNegativeInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const loopControlEnvBindings: EnvBindings<LoopControl> = envBindings(LoopControlSchema, {
  maxStepsPerTurn: { env: LOOP_MAX_STEPS_PER_TURN_ENV, parse: parseNonNegativeInt },
  maxAttemptsPerStep: {
    env: LOOP_MAX_ATTEMPTS_PER_STEP_ENV,
    deprecatedEnv: LOOP_MAX_RETRIES_PER_STEP_ENV,
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
