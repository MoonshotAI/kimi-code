import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { TOWER_FLAG_ID } from './tower';

export const TOWER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TOWER';

export const towerFlag: FlagDefinitionInput = {
  id: TOWER_FLAG_ID,
  title: 'Tower multi-agent orchestration',
  description: 'Coordinate parallel worker agents through Tower tools and the tower mode.',
  env: TOWER_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(towerFlag);
