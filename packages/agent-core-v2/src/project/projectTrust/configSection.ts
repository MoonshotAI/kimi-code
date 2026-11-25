import { z } from 'zod';

import { type IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const WORKSPACE_TRUST_SECTION = 'workspace';

export const ProjectTrustConfigSchema = z.object({
  requireTrust: z.boolean().optional(),
});

export type ProjectTrustConfig = z.infer<typeof ProjectTrustConfigSchema>;

export const DEFAULT_PROJECT_TRUST_CONFIG: ProjectTrustConfig = {
  requireTrust: true,
};

export function projectTrustRequired(config: IConfigService): boolean {
  return config.get<ProjectTrustConfig | undefined>(WORKSPACE_TRUST_SECTION)?.requireTrust ?? true;
}

registerConfigSection(WORKSPACE_TRUST_SECTION, ProjectTrustConfigSchema, {
  defaultValue: DEFAULT_PROJECT_TRUST_CONFIG,
});
