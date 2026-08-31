import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { TOWER_FLAG_ID } from './tower';

export const TOWER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TOWER';

export const towerFlag: FlagDefinitionInput = {
  id: TOWER_FLAG_ID,
  title: 'Tower mode',
  description:
    'Enable tower mode: coordinate multiple agents on a shared objective, toggled with the /tower command.',
  env: TOWER_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(towerFlag);
