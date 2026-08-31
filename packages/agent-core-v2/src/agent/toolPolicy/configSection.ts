import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const TOOLS_SECTION = 'tools';

export const ToolsConfigSchema = z.object({
  enabled: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

registerConfigSection(TOOLS_SECTION, ToolsConfigSchema);
