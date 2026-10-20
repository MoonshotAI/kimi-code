import { z } from 'zod';

import type { ConfigSectionContribution } from '#/features/config/index';

export const DEFAULT_PLAN_MODE_CONFIG_SECTION = 'defaultPlanMode';

export const defaultPlanModeSection: ConfigSectionContribution<boolean> = {
  name: DEFAULT_PLAN_MODE_CONFIG_SECTION,
  schema: z.boolean(),
  defaultValue: false,
};
