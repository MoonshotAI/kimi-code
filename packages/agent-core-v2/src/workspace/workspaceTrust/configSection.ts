import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const WORKSPACE_TRUST_SECTION = 'workspace';

export const WorkspaceTrustConfigSchema = z.object({
  requireTrust: z.boolean().optional(),
});

export type WorkspaceTrustConfig = z.infer<typeof WorkspaceTrustConfigSchema>;

export const DEFAULT_WORKSPACE_TRUST_CONFIG: WorkspaceTrustConfig = {
  requireTrust: true,
};

registerConfigSection(WORKSPACE_TRUST_SECTION, WorkspaceTrustConfigSchema, {
  defaultValue: DEFAULT_WORKSPACE_TRUST_CONFIG,
});
