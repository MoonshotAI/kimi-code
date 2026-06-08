import type { FlagDefinitionInput } from './types';

/**
 * Experimental feature flags.
 *
 * To add one, append an entry and gate runtime behavior through the scoped
 * resolver available on `KimiCore`, `Session`, or `Agent`:
 *   { id: 'my_feature', title: 'My feature', description: '...', env: 'KIMI_CODE_EXPERIMENTAL_MY_FEATURE', default: false, surface: 'both' }
 *
 * Keep the `as const satisfies` — it derives the literal `FlagId` union that gives `enabled()`
 * autocomplete and typo-checking. `env` must start with 'KIMI_CODE_EXPERIMENTAL_', be unique, and
 * not equal the master switch 'KIMI_CODE_EXPERIMENTAL_FLAG'; `id` must not be 'flag'.
 */
export const FLAG_DEFINITIONS = [
  {
    id: 'goal_command',
    title: 'Goal command',
    description: 'Enable /goal and goal-management tools for longer autonomous tasks.',
    env: 'KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND',
    default: false,
    surface: 'both',
  },
  {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older large tool results from context while keeping recent conversation intact.',
    env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    default: false,
    surface: 'core',
  },
  {
    id: 'background_ask',
    title: 'Background questions',
    description: 'Allow AskUserQuestion to return a background task when the agent can continue working.',
    env: 'KIMI_CODE_EXPERIMENTAL_BACKGROUND_ASK',
    default: false,
    surface: 'core',
  },
  {
    id: 'sub_skill',
    title: 'Sub-skill',
    description: 'Enable discovery of nested skills inside skill bundles that declare has-sub-skill.',
    env: 'KIMI_CODE_EXPERIMENTAL_SUB_SKILL',
    default: false,
    surface: 'core',
  },
] as const satisfies readonly FlagDefinitionInput[];

/** Literal union of registered flag ids. */
export type FlagId = (typeof FLAG_DEFINITIONS)[number]['id'];
