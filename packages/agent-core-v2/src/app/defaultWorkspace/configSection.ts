import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEFAULT_WORKSPACE_SECTION = 'defaultWorkspace';

export const DefaultWorkspaceConfigSchema = z.object({
  path: z.string().optional(),
});

export type DefaultWorkspaceConfig = z.infer<typeof DefaultWorkspaceConfigSchema>;

registerConfigSection(DEFAULT_WORKSPACE_SECTION, DefaultWorkspaceConfigSchema, {
  defaultValue: {},
});
