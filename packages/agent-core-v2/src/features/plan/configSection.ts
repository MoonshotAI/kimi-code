import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEFAULT_PLAN_MODE_SECTION = 'defaultPlanMode';

export const DefaultPlanModeSchema = z.boolean().optional();

export type DefaultPlanMode = z.infer<typeof DefaultPlanModeSchema>;

registerConfigSection(DEFAULT_PLAN_MODE_SECTION, DefaultPlanModeSchema, {
  defaultValue: false,
});
