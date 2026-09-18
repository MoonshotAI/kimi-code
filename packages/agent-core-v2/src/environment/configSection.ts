import { registerConfigSection } from '#/app/config/configSectionContributions';

import { EnvironmentsSectionSchema } from './remoteEnvironmentDeclaration';

export const ENVIRONMENTS_SECTION = 'environments';

registerConfigSection(ENVIRONMENTS_SECTION, EnvironmentsSectionSchema);
