import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const READ_SECTION = 'read';

export const ReadConfigSchema = z.object({
  defaultMaxChars: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
});

export type ReadConfig = z.infer<typeof ReadConfigSchema>;

registerConfigSection(READ_SECTION, ReadConfigSchema, { defaultValue: {} });
