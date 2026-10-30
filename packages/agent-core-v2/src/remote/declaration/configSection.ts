import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import {
  EnvironmentsSectionSchema,
  sectionEntries,
  type EnvironmentDeclarationSet,
  type EnvironmentsSection,
} from './remoteEnvironmentDeclaration';

export const ENVIRONMENTS_SECTION = 'environments';

registerConfigSection(ENVIRONMENTS_SECTION, EnvironmentsSectionSchema);

export async function resolveWorkspaceEnvironmentDeclarations(
  config: IConfigService,
): Promise<EnvironmentDeclarationSet> {
  await config.ready;
  config.assertValid(ENVIRONMENTS_SECTION);
  const user = config.get<EnvironmentsSection | undefined>(ENVIRONMENTS_SECTION);
  const entries = sectionEntries(user);
  return { entries, defaultId: user?.default };
}
