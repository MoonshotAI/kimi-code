import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const EXTRA_AGENT_DIRS_SECTION = 'extraAgentDirs';
export const ExtraAgentDirsConfigSchema = z.array(z.string()).optional();
export type ExtraAgentDirsConfig = z.infer<typeof ExtraAgentDirsConfigSchema>;

registerConfigSection(EXTRA_AGENT_DIRS_SECTION, ExtraAgentDirsConfigSchema, {
  defaultValue: [],
});
