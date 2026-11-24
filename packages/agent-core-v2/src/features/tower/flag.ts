import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { TOWER_FLAG_ENV, TOWER_FLAG_ID } from './tower';
import { isTowerFeatureAssembled } from './towerFeature';

export { TOWER_FLAG_ENV };

export const towerFlag: FlagDefinitionInput = {
  id: TOWER_FLAG_ID,
  title: 'Tower mode',
  description:
    'Enable tower mode: coordinate multiple agents on a shared objective, toggled with the /tower command.',
  env: TOWER_FLAG_ENV,
  stages: {
    tui: 'experimental',
    desktop: 'experimental',
    web: 'experimental',
  },
  effectTiming: 'restart',
  isExposed: (flags) => isTowerFeatureAssembled(flags),
};

registerFlagDefinition(towerFlag);
