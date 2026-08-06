/**
 * `plan` domain — registers the `defaultPlanMode` config section into
 * `config`.
 *
 * Top-level boolean preference (`default_plan_mode` on disk, v1-compatible):
 * when `true`, every freshly created session starts in plan mode. Resumed /
 * forked sessions restore plan state from wire records and ignore this.
 * Stays on the static import=register channel (not the Feature's runtime
 * contribution) so the section remains statically discoverable — the config
 * manifest generator drains the module-level table. Bound at App scope.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEFAULT_PLAN_MODE_SECTION = 'defaultPlanMode';

export const DefaultPlanModeSchema = z.boolean().optional();

export type DefaultPlanMode = z.infer<typeof DefaultPlanModeSchema>;

registerConfigSection(DEFAULT_PLAN_MODE_SECTION, DefaultPlanModeSchema, {
  defaultValue: false,
});
