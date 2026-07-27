/**
 * `loop` domain (L4) — `loopControl` config-section schema, env bindings, and
 * TOML transforms.
 *
 * Owns the `[loop_control]` configuration section (step / retry / context-size
 * limits) consumed by `AgentLoopService` (step + retry budgets) and `AgentProfileService`
 * (context sizing), plus the snake_case ↔ camelCase TOML transforms (including
 * the legacy `max_steps_per_run` → `maxStepsPerTurn` rename). The step and retry
 * budgets also accept operational env overrides (`KIMI_LOOP_MAX_STEPS_PER_TURN`
 * / `KIMI_LOOP_MAX_RETRIES_PER_STEP`); `config` resolves each field as
 * `env > config.toml > default` and re-applies the env binding on every read.
 * Self-registered at module load via `registerConfigSection`.
 *
 * While a field's env var is set, `stripEnvBoundFields` restores its env-free
 * raw value before `set`/`replace` persists, so an env override echoed
 * back through a config write can never leak into `config.toml`.
 */

import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { plainObjectToToml, transformPlainObject } from '#/app/config/toml';

export const LOOP_CONTROL_SECTION = 'loopControl';

export const LOOP_MAX_STEPS_PER_TURN_ENV = 'KIMI_LOOP_MAX_STEPS_PER_TURN';
export const LOOP_MAX_RETRIES_PER_STEP_ENV = 'KIMI_LOOP_MAX_RETRIES_PER_STEP';

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxRetriesPerStep: z.number().int().min(0).optional(),
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
  maxRetriesPerStep: { env: LOOP_MAX_RETRIES_PER_STEP_ENV, parse: parseNonNegativeInt },
});

export const stripLoopControlEnv = stripEnvBoundFields(loopControlEnvBindings);

export const loopControlFromToml = (rawSnake: unknown): unknown => {
  if (rawSnake === null || typeof rawSnake !== 'object' || Array.isArray(rawSnake)) return rawSnake;
  const out = transformPlainObject(rawSnake as Record<string, unknown>);
  if (out['maxStepsPerTurn'] === undefined && out['maxStepsPerRun'] !== undefined) {
    out['maxStepsPerTurn'] = out['maxStepsPerRun'];
  }
  delete out['maxStepsPerRun'];
  return out;
};

export const loopControlToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return plainObjectToToml(value as Record<string, unknown>, rawSnake);
};

registerConfigSection(LOOP_CONTROL_SECTION, LoopControlSchema, {
  fromToml: loopControlFromToml,
  toToml: loopControlToToml,
  env: loopControlEnvBindings,
  stripEnv: stripLoopControlEnv,
});
