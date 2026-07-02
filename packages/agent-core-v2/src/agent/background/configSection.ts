/**
 * `background` domain (L5) — `background` config-section schema.
 *
 * Owns the `[background]` configuration section (background-task limits and
 * lifecycle tuning). Self-registered at module load via `registerConfigSection`,
 * so the `config` domain never imports this domain's types.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const BACKGROUND_SECTION = 'background';

export const BackgroundConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
});

export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;

registerConfigSection(BACKGROUND_SECTION, BackgroundConfigSchema);
