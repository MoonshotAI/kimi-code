import { z } from 'zod';

import { type IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const WORKSPACE_TRUST_SECTION = 'workspace';

export const WorkspaceTrustConfigSchema = z.object({
  requireTrust: z.boolean().optional(),
});

export type WorkspaceTrustConfig = z.infer<typeof WorkspaceTrustConfigSchema>;

export const DEFAULT_WORKSPACE_TRUST_CONFIG: WorkspaceTrustConfig = {
  requireTrust: true,
};

export function workspaceTrustRequired(config: IConfigService): boolean {
  return config.get<WorkspaceTrustConfig | undefined>(WORKSPACE_TRUST_SECTION)?.requireTrust ?? true;
}

registerConfigSection(WORKSPACE_TRUST_SECTION, WorkspaceTrustConfigSchema, {
  defaultValue: DEFAULT_WORKSPACE_TRUST_CONFIG,
});
