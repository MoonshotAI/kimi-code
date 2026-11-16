import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { ARTEX_FLAG_ENV, ARTEX_FLAG_ID } from './artex';
import { isArtexFeatureAssembled } from './artex';

export const artexFlag: FlagDefinitionInput = {
  id: ARTEX_FLAG_ID,
  title: 'ARTEX autonomous pentest',
  description:
    'Enable the ARTEX autonomous-pentest intelligence: a native dual-graph exploration engine (asset + exploration graphs, coverage ledger, cold-digest compaction, hierarchical budgets) that drives the swarm.',
  env: ARTEX_FLAG_ENV,
  default: false,
  surface: 'both',
  isExposed: (flags) => isArtexFeatureAssembled(flags),
};

registerFlagDefinition(artexFlag);
