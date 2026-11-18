import { z } from 'zod';

import { registerConfigSection } from './configSectionContributions';

export const ENVIRONMENTS_SECTION = 'environments';

registerConfigSection(ENVIRONMENTS_SECTION, z.unknown(), {
  collectDiagnostics: (section) =>
    section === undefined
      ? []
      : [{
          domain: ENVIRONMENTS_SECTION,
          severity: 'warning',
          message: '[environments] has been removed; configure SSH sessions with [hosts] instead.',
        }],
});
