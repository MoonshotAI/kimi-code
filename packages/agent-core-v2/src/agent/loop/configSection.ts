/**
 * `loop` domain (L4) — `loopControl` config-section schema and TOML transforms.
 *
 * Owns the `[loop_control]` configuration section (step / retry / context-size
 * limits) consumed by `AgentLoopService` (step + retry budgets) and `AgentProfileService`
 * (context sizing), plus the snake_case ↔ camelCase TOML transforms (including
 * the legacy `max_steps_per_run` → `maxStepsPerTurn` rename). Self-registered at
 * module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { plainObjectToToml, transformPlainObject } from '#/app/config/toml';

export const LOOP_CONTROL_SECTION = 'loopControl';

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxRetriesPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
});

export type LoopControl = z.infer<typeof LoopControlSchema>;

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
});
