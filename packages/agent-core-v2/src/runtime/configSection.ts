import { registerConfigSection } from '#/app/config/configSectionContributions';

import { RuntimesSectionSchema } from './remoteRuntimeDeclaration';

export const RUNTIMES_SECTION = 'runtimes';

registerConfigSection(RUNTIMES_SECTION, RuntimesSectionSchema);
