/**
 * `plan` domain (L3) — `defaultPlanMode` config section.
 *
 * Top-level boolean preference (`default_plan_mode` on disk, v1-compatible):
 * when `true`, every freshly created session starts in plan mode. Resumed /
 * forked sessions restore plan state from wire records and ignore this. Read by
 * `sessionLifecycle` at session creation; runtime plan state lives on the wire
 * `PlanModel`, not here.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEFAULT_PLAN_MODE_SECTION = 'defaultPlanMode';

export const DefaultPlanModeSchema = z.boolean().optional();

export type DefaultPlanMode = z.infer<typeof DefaultPlanModeSchema>;

registerConfigSection(DEFAULT_PLAN_MODE_SECTION, DefaultPlanModeSchema, {
  defaultValue: false,
});
